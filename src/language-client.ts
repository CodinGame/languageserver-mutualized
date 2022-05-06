import * as rpc from '@codingame/monaco-jsonrpc'
import {
  CodeLensRefreshRequest, InitializedNotification, InitializeRequest, PublishDiagnosticsNotification, RegistrationRequest,
  UnregistrationRequest, ConfigurationRequest, Event, SemanticTokensRefreshRequest, DidChangeConfigurationNotification,
  LogMessageNotification, WorkspaceFoldersRequest, WorkDoneProgressCreateRequest, ShutdownRequest, ShowMessageNotification,
  ShowMessageRequest, DidOpenTextDocumentNotification,
  DidCloseTextDocumentNotification, TextDocumentSyncKind, DidChangeTextDocumentNotification, ExecuteCommandRequest,
  LogMessageParams, ApplyWorkspaceEditParams, ApplyWorkspaceEditResponse, Diagnostic, TextDocumentItem, DidSaveTextDocumentNotification, WillSaveTextDocumentWaitUntilRequest, TextDocumentIdentifier
} from 'vscode-languageserver-protocol'
import {
  ApplyWorkspaceEditRequest,
  InitializeParams,
  PublishDiagnosticsParams,
  TextDocuments,
  TextDocumentSaveReason,
  WillSaveTextDocumentNotification
} from 'vscode-languageserver/node'
import { Emitter, ResponseError, ErrorCodes, Disposable, DisposableCollection, NotificationMessage } from '@codingame/monaco-jsonrpc'
import setValueBySection from 'set-value'
import { DocumentUri, TextDocument } from 'vscode-languageserver-textdocument'
import winston from 'winston'
import debounce from 'debounce'
import { WatchableServerCapabilities } from './capabilities'
import { lspDiff } from './tools/lsp'
import { ConnectionRequestCache, createMemoizedConnection } from './tools/cache'
import { allVoidMerger, MultiRequestHandler, RequestHandlerRegistration, singleHandlerMerger } from './tools/request-handler'
import { runWithTimeout } from './tools/node'

export enum LanguageClientDisposeReason {
  Remote,
  Local
}

export type BindContext = <P extends unknown[], R> (fn: (...args: P) => R) => (...args: P) => R
export interface LanguageClientOptions {
  synchronizeConfigurationSections?: string[]
  getConfiguration?: (key: string) => unknown
  disableSaveNotifications?: boolean
  createCache?: () => ConnectionRequestCache
  logger?: winston.Logger
  unhandledNotificationHandler?: (e: NotificationMessage) => void
}

export function createLanguageClient (connection: rpc.MessageConnection, options: LanguageClientOptions = {}): LanguageClient {
  const languageClient = new LanguageClient(
    connection,
    options
  )
  return languageClient
}

export class LanguageClient implements Disposable {
  private disposed: boolean = false

  private _onDocumentOpen = new Emitter<TextDocument>()
  private _onDocumentChanged = new Emitter<TextDocument>()
  private _onDocumentClosed = new Emitter<TextDocument>()

  private serverCapabilities: WatchableServerCapabilities | undefined
  private connectionPromise: Promise<rpc.MessageConnection> | undefined
  private connection: rpc.MessageConnection | undefined
  private ready: boolean
  private _onDispose = new Emitter<LanguageClientDisposeReason>()
  private lastDiagnostics = new Map<string, Diagnostic[]>()
  private _onDiagnostics = new Emitter<PublishDiagnosticsParams>()
  private _onCodeLensRefresh = new MultiRequestHandler<void, void, void>(CodeLensRefreshRequest.type, allVoidMerger)
  private _onSemanticTokensRefresh = new MultiRequestHandler<void, void, void>(SemanticTokensRefreshRequest.type, allVoidMerger)
  private _workspaceApplyEditRequestHandler = new MultiRequestHandler(ApplyWorkspaceEditRequest.type, singleHandlerMerger({
    applied: false
  }))

  private currentDocuments = new Map<string, TextDocument>()
  // private currentDocumentMasters = new Map<string, TextDocuments<TextDocument>>()

  private synchronizedDocuments: TextDocuments<TextDocument>[] = []
  private logMessages: LogMessageParams[]
  private cache?: ConnectionRequestCache

  constructor (
    private _connection: rpc.MessageConnection,
    public readonly options: LanguageClientOptions
  ) {
    this.ready = false
    this.logMessages = []
    this.cache = options.createCache?.()
  }

  get onDispose (): Event<LanguageClientDisposeReason> {
    return this._onDispose.event
  }

  get onDiagnostics (): Event<PublishDiagnosticsParams> {
    return this._onDiagnostics.event
  }

  get onDocumentOpen (): Event<TextDocument> {
    return this._onDocumentOpen.event
  }

  get onDocumentChanged (): Event<TextDocument> {
    return this._onDocumentChanged.event
  }

  get onDocumentClosed (): Event<TextDocument> {
    return this._onDocumentClosed.event
  }

  public get onWorkspaceApplyEdit (): RequestHandlerRegistration<ApplyWorkspaceEditParams, ApplyWorkspaceEditResponse, void> {
    return this._workspaceApplyEditRequestHandler.onRequest
  }

  get onCodeLensRefresh (): RequestHandlerRegistration<void, void, void> {
    return this._onCodeLensRefresh.onRequest
  }

  get onSemanticTokensRefresh (): RequestHandlerRegistration<void, void, void> {
    return this._onSemanticTokensRefresh.onRequest
  }

  private async startConnection (initializeParams: InitializeParams): Promise<rpc.MessageConnection> {
    const connection = this.cache != null ? createMemoizedConnection(this._connection, this.cache) : this._connection
    connection.onRequest(RegistrationRequest.type, (params) => {
      this.serverCapabilities!.handleRegistrationRequest(params)
    })

    connection.onRequest(UnregistrationRequest.type, (params) => {
      this.serverCapabilities!.handleUnregistrationRequest(params)
    })

    connection.onRequest(ConfigurationRequest.type, (params) => {
      return params.items.map((item) => item.section == null ? null : this.options.getConfiguration?.(item.section))
    })
    connection.onRequest(CodeLensRefreshRequest.type, (token) => {
      return this._onCodeLensRefresh.sendRequest(undefined, token)
    })
    connection.onRequest(SemanticTokensRefreshRequest.type, (token) => {
      return this._onSemanticTokensRefresh.sendRequest(undefined, token)
    })
    connection.onRequest(ExecuteCommandRequest.type, (params) => {
      this.options.logger?.debug(`Ignored Execute command from server ${params.command}(${JSON.stringify(params.arguments)})`)
    })
    connection.onRequest(ApplyWorkspaceEditRequest.type, async (params, token) => {
      return this._workspaceApplyEditRequestHandler.sendRequest(params, token)
    })
    connection.onNotification(PublishDiagnosticsNotification.type, (notif) => {
      this._onDiagnostics.fire(notif)
      if (this.isDocumentOpen(notif.uri)) {
        this.lastDiagnostics.set(notif.uri, notif.diagnostics)
      }
    })
    connection.onNotification(LogMessageNotification.type, (params) => {
      this.logMessages.push(params)
      this.options.logger?.debug(`Log message from server (${params.type}): ${params.message}`)
    })
    connection.onNotification(ShowMessageNotification.type, (params) => {
      this.options.logger?.debug(`Show message from server (${params.type}): ${params.message}`)
    })
    connection.onRequest(ShowMessageRequest.type, (params) => {
      this.options.logger?.warn('Unexpected ShowMessageRequest', params)
      return null
    })
    connection.onRequest(WorkDoneProgressCreateRequest.type, () => {
      // FIXME: forward request to clients?
    })
    connection.onUnhandledNotification(this.options.unhandledNotificationHandler ?? (() => null))
    connection.onUnhandledProgress(() => {})
    connection.onRequest((method, params) => {
      this.options.logger?.error(`Unhandled request: ${method}, params: ${JSON.stringify(params)}`)
      throw new ResponseError(ErrorCodes.MethodNotFound, `Unhandled method ${method}`)
    })
    connection.onRequest(WorkspaceFoldersRequest.type, () => {
      return initializeParams.workspaceFolders
    })
    connection.listen()

    connection.onDispose(() => {
      const byRemote = !this.disposed
      this.disposed = true
      this._onDispose.fire(byRemote ? LanguageClientDisposeReason.Remote : LanguageClientDisposeReason.Local)
    })

    const initializationResult = await connection.sendRequest(InitializeRequest.type, initializeParams)
    this.serverCapabilities = new WatchableServerCapabilities(initializationResult.capabilities)

    connection.sendNotification(InitializedNotification.type, {})

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const synchronizeConfigurationSections = this.options.synchronizeConfigurationSections
    if (synchronizeConfigurationSections != null && synchronizeConfigurationSections.length > 0) {
      const synchronizedConfiguration = synchronizeConfigurationSections.reduce((config, section) => {
        setValueBySection(config, section, this.options.getConfiguration?.(section))
        return config
      }, {})

      connection.sendNotification(DidChangeConfigurationNotification.type, {
        settings: synchronizedConfiguration
      })
    }

    return connection
  }

  public getLogMessages (): LogMessageParams[] {
    return this.logMessages
  }

  private openDocument (document: TextDocument) {
    if (this.isDocumentOpen(document.uri)) {
      return
    }
    const serverCapabilities = this.serverCapabilities!
    const textDocumentSync = serverCapabilities.getResolvedDocumentSync()
    const serverConnection = this.connection!
    const newTextDocument = TextDocument.create(document.uri, document.languageId, 1, document.getText())
    this.currentDocuments.set(document.uri, newTextDocument)
    if (textDocumentSync?.openClose ?? false) {
      const textDocumentItem = TextDocumentItem.create(newTextDocument.uri, newTextDocument.languageId, newTextDocument.version, newTextDocument.getText())
      serverConnection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: textDocumentItem
      })
    }

    this._onDocumentOpen.fire(newTextDocument)

    this.cache?.reset()
  }

  private updateDocuments (documents: TextDocuments<TextDocument>) {
    for (const document of documents.all()) {
      this.updateDocument(document)
    }
  }

  private updateDocument (document: TextDocument): void {
    const serverCapabilities = this.serverCapabilities!
    const documentSyncKind = serverCapabilities.getTextDocumentSyncKind()
    const newCode = document.getText()
    const currentDocument = this.currentDocuments.get(document.uri)!
    if (currentDocument.getText() === newCode) {
      return
    }

    /**
     * Computing a diff can take a LONG time (> 1 second) when the old code and the new code are very different (after a copy/paste for instance).
     *
     * The change comming from the client is probably a whole code replacement already,
     * but we have no way to know it here because it's only managed in vscode-languageserver `TextDocuments` class.
     *
     * There is no point of building a HUGE minimal diff when computing it from 2 different codes.
     * Running a fonction for more than some milliseconds blocks the javascript event loop, making everyone else freeze, so it's not acceptable.
     *
     * There is also no simple heuristic to know if 2 codes are closer to each other or not.
     *
     * So the simplest way is to try to compute the diff but give up if it takes to much time.
     * The only consequence of it is it will make the LSP think the whole file was changed,
     * leading to a new parsing of it (But I doubt sending a huge diff is better).
     */

    const lspDiffWithTimeout = (oldCode: string, newCode: string) => {
      try {
        return runWithTimeout(() => lspDiff(oldCode, newCode), 20)
      } catch (error) {
        this.options.logger?.error('Unable to compute diff between old code and new code, resetting the whole code', { error })
        return [{
          text: newCode
        }]
      }
    }

    const contentChanges = documentSyncKind === TextDocumentSyncKind.Incremental
      ? lspDiffWithTimeout(currentDocument.getText(), newCode)
      : [{
          text: newCode
        }]

    const newDocument = TextDocument.update(currentDocument, contentChanges, currentDocument.version + 1)

    const serverConnection = this.connection!
    if (documentSyncKind !== TextDocumentSyncKind.None) {
      serverConnection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: {
          uri: newDocument.uri,
          version: newDocument.version
        },
        contentChanges
      })
    }

    this.cache?.reset()

    this.currentDocuments.set(document.uri, newDocument)

    this._onDocumentChanged.fire(newDocument)
  }

  private closeDocument (document: TextDocument) {
    if (this.synchronizedDocuments.some(docs => docs.get(document.uri) != null)) {
      // Still open elsewhere
      return
    }
    const currentDocument = this.currentDocuments.get(document.uri)!

    const serverCapabilities = this.serverCapabilities!
    const textDocumentSync = serverCapabilities.getResolvedDocumentSync()
    const serverConnection = this.connection!
    if (textDocumentSync?.openClose ?? false) {
      serverConnection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: TextDocumentIdentifier.create(document.uri)
      })
    }
    this.lastDiagnostics.delete(document.uri)
    this.currentDocuments.delete(document.uri)
    this.cache?.reset()

    this._onDocumentClosed.fire(currentDocument)
  }

  private isDocumentOpen (uri: DocumentUri): boolean {
    return this.currentDocuments.has(uri)
  }

  public getLastDiagnostics (uri: string): Diagnostic[] | undefined {
    return this.lastDiagnostics.get(uri)
  }

  public synchronize (documents: TextDocuments<TextDocument>, flushEvent: Event<void>): Disposable {
    const disposableCollection = new DisposableCollection()
    this.synchronizedDocuments.push(documents)

    for (const document of documents.all()) {
      this.openDocument(document)
    }
    disposableCollection.push(Disposable.create(() => {
      const index = this.synchronizedDocuments.indexOf(documents)
      if (index >= 0) {
        this.synchronizedDocuments.splice(index, 1)
      }
      // ALways remove from the synchronized documents BEFORE closing the document
      for (const document of documents.all()) {
        this.closeDocument(document)
      }
    }))

    disposableCollection.push(documents.onDidOpen(e => {
      this.openDocument(e.document)
    }))
    disposableCollection.push(documents.onDidClose(e => {
      this.closeDocument(e.document)
    }))

    const debouncedUpdateDocuments = debounce(this.updateDocuments.bind(this), 500)
    flushEvent(() => {
      debouncedUpdateDocuments.flush()
    })
    disposableCollection.push(Disposable.create(() => {
      debouncedUpdateDocuments.clear()
    }))

    disposableCollection.push(documents.onDidChangeContent(() => {
      debouncedUpdateDocuments(documents)
    }))

    if (!(this.options.disableSaveNotifications ?? false)) {
      disposableCollection.push(documents.onDidSave(e => {
        this.sendDidSaveNotification(e.document)
      }))
      disposableCollection.push(documents.onWillSave(e => {
        this.sendWillSaveNotification(e.document, e.reason)
      }))
    }

    return disposableCollection
  }

  public sendWillSaveNotification (document: TextDocument, reason: TextDocumentSaveReason): void {
    const serverCapabilities = this.serverCapabilities!
    const serverConnection = this.connection!
    const saveOptions = serverCapabilities.getResolvedDocumentSyncSaveOptions()
    if (saveOptions != null) {
      serverConnection.sendNotification(WillSaveTextDocumentNotification.type, {
        textDocument: {
          uri: document.uri
        },
        reason
      })
    }
  }

  public async sendWillSave (document: TextDocument, reason: TextDocumentSaveReason): Promise<void> {
    this.sendWillSaveNotification(document, reason)

    const serverCapabilities = this.serverCapabilities!
    const serverConnection = this.connection!
    if (serverCapabilities.getResolvedDocumentSync()?.willSaveWaitUntil ?? false) {
      await serverConnection.sendRequest(WillSaveTextDocumentWaitUntilRequest.type, {
        textDocument: {
          uri: document.uri
        },
        reason
      })
    }
  }

  public sendDidSaveNotification (document: TextDocument): void {
    const serverCapabilities = this.serverCapabilities!
    const serverConnection = this.connection!
    const saveOptions = serverCapabilities.getResolvedDocumentSyncSaveOptions()
    if (saveOptions != null) {
      const includeText = saveOptions.includeText ?? false
      serverConnection.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: {
          uri: document.uri
        },
        text: includeText ? document.getText() : undefined
      })
    }
  }

  public getServerConnection (): rpc.MessageConnection {
    return this.connection!
  }

  public async start (initializeParams: InitializeParams): Promise<void> {
    if (this.connectionPromise == null) {
      this.connectionPromise = this.startConnection(initializeParams)
      try {
        await this.connectionPromise
      } catch (err) {
        this.disposed = true
        this._onDispose.fire(LanguageClientDisposeReason.Local)
        throw err
      }
    }
    this.connection = await this.connectionPromise
  }

  public isReady (): boolean {
    return this.ready
  }

  public getConnection (): Promise<rpc.MessageConnection> {
    return this.connectionPromise!
  }

  public getServerCapabilities (): WatchableServerCapabilities {
    return this.serverCapabilities!
  }

  public isDisposed (): boolean {
    return this.disposed
  }

  public async dispose (): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const connection = await this.connectionPromise
    try {
      await connection?.sendRequest(ShutdownRequest.type)
    } finally {
      connection?.dispose()
    }
  }
}
