import * as rpc from 'vscode-jsonrpc'
import {
  ClientCapabilities,
  CodeLensRefreshRequest,
  DiagnosticRefreshRequest,
  DidChangeConfigurationNotification,
  InitializedNotification,
  InitializedParams,
  InlayHintRefreshRequest,
  InlineValueRefreshRequest,
  PublishDiagnosticsNotification,
  SemanticTokensRefreshRequest,
  TextDocumentSyncOptions,
  WillSaveTextDocumentNotification,
  WillSaveTextDocumentWaitUntilRequest
} from 'vscode-languageserver-protocol'
import {
  TextDocuments,
  createConnection,
  WatchDog,
  ApplyWorkspaceEditRequest,
  TextDocumentEdit,
  ServerRequestHandler
} from 'vscode-languageserver/lib/common/api'
import { DocumentUri, TextDocument } from 'vscode-languageserver-textdocument'
import { CancellationToken, Disposable, Emitter, HandlerResult } from 'vscode-jsonrpc'
import ms from 'ms'
import winston from 'winston'
import { forwardedClientRequests } from './constants/lsp'
import { synchronizeLanguageServerCapabilities, transformServerCapabilities } from './capabilities'
import { BindContext, LanguageClient, LanguageClientDisposeReason } from './language-client'
import pDefer from './tools/p-defer'
import { timeout, TimeoutError } from './tools/promise'
import { DisposableCollection } from './tools/disposable'

export class ConnectionClosedError extends Error {
  constructor (message: string = 'Connection closed') {
    super(message)
  }
}

export interface UnknownRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (serverConnection: rpc.MessageConnection, method: string, params: any[] | object | undefined, token: CancellationToken): HandlerResult<any, any>
}

export interface LanguageClientBindingOptions {
  clientInitializationTimeout?: number
  serverName?: string
  bindContext?: BindContext
  logger?: winston.Logger
  unknownClientRequestHandler?: UnknownRequestHandler
}

export enum EndCause {
  Client = 'client',
  Server = 'server'
}

export async function bindLanguageClient (
  languageClient: LanguageClient,
  clientMessageConnection: rpc.MessageConnection,
  options: LanguageClientBindingOptions = {}
): Promise<EndCause> {
  const bindContext: BindContext = options.bindContext ?? (fn => fn)

  const watchDog: WatchDog = {
    shutdownReceived: false,
    initialize: function (): void {},
    exit: function (): void {}
  }

  let disposed: boolean = false

  const disposableCollection = new DisposableCollection()
  try {
    const clientConnection = createConnection(() => clientMessageConnection, watchDog)
    disposableCollection.push(clientMessageConnection.onDispose(() => {
      clientConnection.dispose()
    }))

    clientConnection.onShutdown(bindContext(() => {
      options.logger?.debug('Shutdown request received from client')
    }))
    const connectionClosePromise = new Promise<void>(_resolve => {
      const resolve = () => {
        disposed = true
        _resolve()
      }
      clientConnection.onExit(resolve)
      clientMessageConnection.onDispose(resolve)
    })

    function waitClientMessage<T> (promise: Promise<T>): Promise<T> {
      return Promise.race([
        timeout(options.clientInitializationTimeout ?? ms('10 seconds'), promise, new TimeoutError('Timeout while waiting for client message')),
        connectionClosePromise.then(() => { throw new ConnectionClosedError('Connection closed by client during initialization') })
      ])
    }

    type ClientRequestHandler<Params, Result> = [Params, (result: Result) => void]
    async function waitClientRequest<Params, Result, Error> (listen: (handler: ServerRequestHandler<Params, Result, never, Error>) => void): Promise<ClientRequestHandler<Params, Result>> {
      const clientRequestHandlerPromise = new Promise<ClientRequestHandler<Params, Result>>(resolve => {
        async function handleClientRequestMessage (params: Params) {
          const deferred = pDefer<Result>()
          resolve([
            params,
            (result) => deferred.resolve(result)
          ])
          return deferred.promise
        }

        listen(bindContext(handleClientRequestMessage))
      })
      return waitClientMessage(clientRequestHandlerPromise)
    }

    const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)
    documents.listen(clientConnection)
    clientConnection.listen()

    const [initParams, sendInitializationResult] = await waitClientRequest(clientConnection.onInitialize)
    await languageClient.start(initParams)
    const serverConnection = await languageClient.getConnection()

    if (disposed) {
      throw new ConnectionClosedError()
    }

    disposableCollection.push(bindClientToServer(
      documents,
      languageClient,
      serverConnection,
      clientMessageConnection,
      initParams.capabilities,
      options
    ))

    sendInitializationResult({
      capabilities: transformServerCapabilities(languageClient.getServerCapabilities().getCapabilities(), languageClient.options.disableSaveNotifications ?? false),
      serverInfo: {
        name: options.serverName ?? 'Mutualized server'
      }
    })

    const languageClientClosePromise = new Promise<LanguageClientDisposeReason>(resolve => {
      languageClient.onDispose(resolve)
    })

    await waitClientMessage(new Promise<InitializedParams>((resolve) => {
      clientConnection.onNotification(InitializedNotification.type, resolve)
    }))

    disposableCollection.push(synchronizeLanguageServerCapabilities(languageClient.getServerCapabilities(), clientMessageConnection, options.logger))

    const endCause = await Promise.race([
      connectionClosePromise.then(() => EndCause.Client),
      languageClientClosePromise.then(() => EndCause.Server)
    ])
    return endCause
  } finally {
    disposableCollection.dispose()
  }
}

function bindClientToServer (
  documents: TextDocuments<TextDocument>,
  languageClient: LanguageClient,
  serverConnection: rpc.MessageConnection,
  clientConnection: rpc.MessageConnection,
  clientCapabilities: ClientCapabilities,
  options: LanguageClientBindingOptions
): Disposable {
  const disposableCollection = new DisposableCollection()
  try {
    const serverCapabilities = languageClient.getServerCapabilities()

    const onRequestEmitter = new Emitter<void>()
    disposableCollection.push(languageClient.synchronize(documents, onRequestEmitter.event))
    documents.onDidOpen((e) => {
      const existingDiagnostics = languageClient.getLastDiagnostics(e.document.uri)
      if (existingDiagnostics != null) {
        clientConnection.sendNotification(PublishDiagnosticsNotification.type, {
          uri: e.document.uri,
          diagnostics: existingDiagnostics
        }).catch(error => {
          options.logger?.error('Unable to send notification to client', error)
        })
      }
    })

    function isDocumentOpen (uri: DocumentUri) {
      return documents.get(uri) != null
    }

    const bindContext: BindContext = options.bindContext ?? (fn => fn)

    disposableCollection.push(languageClient.onDiagnostics(bindContext((diag) => {
      if (isDocumentOpen(diag.uri)) {
        clientConnection.sendNotification(PublishDiagnosticsNotification.type, diag).catch(error => {
          options.logger?.error('Unable to send notification to client', error)
        })
      }
    })))

    disposableCollection.push(languageClient.onCodeLensRefresh(bindContext(() => {
      if (clientCapabilities.workspace?.codeLens?.refreshSupport ?? false) {
        clientConnection.sendRequest(CodeLensRefreshRequest.type).catch(error => {
          options.logger?.error('Unable to send Codelens token refresh to client', { error })
        })
      }
    })))
    disposableCollection.push(languageClient.onSemanticTokensRefresh(bindContext(() => {
      if (clientCapabilities.workspace?.semanticTokens?.refreshSupport ?? false) {
        clientConnection.sendRequest(SemanticTokensRefreshRequest.type).catch(error => {
          options.logger?.error('Unable to send semantic token refresh to client', { error })
        })
      }
    })))
    disposableCollection.push(languageClient.onDiagnosticRefresh(bindContext(() => {
      if (clientCapabilities.workspace?.diagnostics?.refreshSupport ?? false) {
        clientConnection.sendRequest(DiagnosticRefreshRequest.type).catch(error => {
          options.logger?.error('Unable to send Diagnostics refresh to client', { error })
        })
      }
    })))
    disposableCollection.push(languageClient.onInlayHintRefresh(bindContext(() => {
      if (clientCapabilities.workspace?.inlayHint?.refreshSupport ?? false) {
        clientConnection.sendRequest(InlayHintRefreshRequest.type).catch(error => {
          options.logger?.error('Unable to send Inlay Hint refresh to client', { error })
        })
      }
    })))
    disposableCollection.push(languageClient.onInlayHintRefresh(bindContext(() => {
      if (clientCapabilities.workspace?.inlineValue?.refreshSupport ?? false) {
        clientConnection.sendRequest(InlineValueRefreshRequest.type).catch(error => {
          options.logger?.error('Unable to send Inline Value refresh to client', { error })
        })
      }
    })))

    disposableCollection.push(languageClient.onWorkspaceApplyEdit(bindContext(params => {
      return clientConnection.sendRequest(ApplyWorkspaceEditRequest.type, {
        label: params.label,
        edit: {
          changes: params.edit.changes != null
            ? Object.fromEntries(
              Object.entries(params.edit.changes).filter(([uri]) => isDocumentOpen(uri))
            )
            : undefined,
          documentChanges: params.edit.documentChanges?.filter(documentEdit => {
            if (TextDocumentEdit.is(documentEdit)) {
              return isDocumentOpen(documentEdit.textDocument.uri)
            }
            return false
          })
        }
      })
    })))

    if ((serverCapabilities.getCapabilities().textDocumentSync as TextDocumentSyncOptions | undefined)?.willSave ?? false) {
      disposableCollection.push(documents.onWillSave(bindContext(async e => {
        serverConnection.sendNotification(WillSaveTextDocumentNotification.type, {
          textDocument: {
            uri: e.document.uri
          },
          reason: e.reason
        }).catch(error => {
          options.logger?.error('Unable to send notification to server', error)
        })
      })))
    }

    if (!(languageClient.options.disableSaveNotifications ?? false)) {
      documents.onWillSaveWaitUntil(bindContext(async (e, token) => {
        return await serverConnection.sendRequest(WillSaveTextDocumentWaitUntilRequest.type, {
          textDocument: {
            uri: e.document.uri
          },
          reason: e.reason
        }, token) ?? []
      }))
    }

    for (const request of forwardedClientRequests) {
      disposableCollection.push(clientConnection.onRequest(request, bindContext(async (params, token) => {
        onRequestEmitter.fire()
        return serverConnection.sendRequest(request, params, token)
      })))
    }

    if (options.unknownClientRequestHandler != null) {
      disposableCollection.push(clientConnection.onRequest(bindContext((method, params, token) => {
        return options.unknownClientRequestHandler?.(serverConnection, method, params, token)
      })))
    }

    disposableCollection.push(clientConnection.onNotification(DidChangeConfigurationNotification.type, bindContext(() => {
      // There is multiple clients on the server, what to do with the configuration?
    })))

    return disposableCollection
  } catch (err) {
    disposableCollection.dispose()
    throw err
  }
}
