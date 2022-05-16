import * as rpc from 'vscode-jsonrpc'
import {
  CodeLensRefreshRequest, InitializedNotification, InitializeRequest, PublishDiagnosticsNotification, RegistrationRequest,
  UnregistrationRequest, ConfigurationRequest, Event, SemanticTokensRefreshRequest, DidChangeConfigurationNotification,
  LogMessageNotification, WorkspaceFoldersRequest, WorkDoneProgressCreateRequest, ShutdownRequest, ShowMessageNotification,
  ShowMessageRequest, DidOpenTextDocumentNotification,
  DidCloseTextDocumentNotification, TextDocumentSyncKind, DidChangeTextDocumentNotification, ExecuteCommandRequest,
  LogMessageParams, ApplyWorkspaceEditParams, ApplyWorkspaceEditResponse, Diagnostic, TextDocumentItem, DidSaveTextDocumentNotification, WillSaveTextDocumentWaitUntilRequest, TextDocumentIdentifier, TextEdit, TextDocumentRegistrationOptions, DidChangeWatchedFilesNotification, FileSystemWatcher, FileEvent, DiagnosticRefreshRequest
} from 'vscode-languageserver-protocol'
import {
  ApplyWorkspaceEditRequest,
  InitializeParams,
  PublishDiagnosticsParams,
  TextDocuments,
  TextDocumentSaveReason,
  WillSaveTextDocumentNotification
} from 'vscode-languageserver/node'
import { Emitter, ResponseError, ErrorCodes, Disposable, NotificationMessage } from 'vscode-jsonrpc'
import setValueBySection from 'set-value'
import { DocumentUri, TextDocument } from 'vscode-languageserver-textdocument'
import winston from 'winston'
import debounce from 'debounce'
import { transformClientCapabilities, WatchableServerCapabilities } from './capabilities'
import { lspDiff, matchDocument } from './tools/lsp'
import { ConnectionRequestCache, createMemoizedConnection } from './tools/cache'
import { allVoidMerger, MultiRequestHandler, RequestHandlerRegistration, singleHandlerMerger } from './tools/request-handler'
import { runWithTimeout } from './tools/node'
import { DisposableCollection } from './tools/disposable'

export enum LanguageClientDisposeReason {
  Remote,
  Local
}

export type BindContext = <P extends unknown[], R> (fn: (...args: P) => R) => (...args: P) => R
export interface LanguageClientOptions {
  synchronizeConfigurationSections?: string[]
  getConfiguration?: (key: string) => unknown
  disableSaveNotifications?: boolean
  interceptDidChangeWatchedFile?: boolean
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

  private _onDidWatchedFileChanged = new Emitter<FileSystemWatcher[]>()

  private serverCapabilities: WatchableServerCapabilities | undefined
  private connectionPromise: Promise<rpc.MessageConnection> | undefined
  private connection: rpc.MessageConnection | undefined
  private ready: boolean
  private _onDispose = new Emitter<LanguageClientDisposeReason>()
  private lastDiagnostics = new Map<string, Diagnostic[]>()
  private _onDiagnostics = new Emitter<PublishDiagnosticsParams>()
  private _onCodeLensRefresh = new MultiRequestHandler<void, void, void>(CodeLensRefreshRequest.type, allVoidMerger)
  private _onSemanticTokensRefresh = new MultiRequestHandler<void, void, void>(SemanticTokensRefreshRequest.type, allVoidMerger)
  private _onDiagnosticsRefresh = new MultiRequestHandler<void, void, void>(DiagnosticRefreshRequest.type, allVoidMerger)
  private _onInlayHintRefresh = new MultiRequestHandler<void, void, void>(InlayHintRefreshRequest.type, allVoidMerger)
  private _onInlineValueRefresh = new MultiRequestHandler<void, void, void>(InlineValueRefreshRequest.type, allVoidMerger)
  private _workspaceApplyEditRequestHandler = new MultiRequestHandler(ApplyWorkspaceEditRequest.type, singleHandlerMerger({
    applied: false
  }))

  private currentDocuments = new Map<string, TextDocument>()

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

  get onDidWatchedFileChanged (): Event<FileSystemWatcher[]> {
    return this._onDidWatchedFileChanged.event
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

  get onDiagnosticsRefresh (): RequestHandlerRegistration<void, void, void> {
    return this._onDiagnosticsRefresh.onRequest
  }

  get onInlayHintRefresh (): RequestHandlerRegistration<void, void, void> {
    return this._onInlayHintRefresh.onRequest
  }

  get onInlineValueRefresh (): RequestHandlerRegistration<void, void, void> {
    return this._onInlineValueRefresh.onRequest
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
    connection.onRequest(DiagnosticRefreshRequest.type, (token) => {
      return this._onDiagnosticsRefresh.sendRequest(undefined, token)
    })
    connection.onRequest(InlayHintRefreshRequest.type, (token) => {
      return this._onInlayHintRefresh.sendRequest(undefined, token)
    })
    connection.onRequest(InlineValueRefreshRequest.type, (token) => {
      return this._onInlineValueRefresh.sendRequest(undefined, token)
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

    const initializationResult = await connection.sendRequest(InitializeRequest.type, {
      ...initializeParams,
      capabilities: transformClientCapabilities(initializeParams.capabilities, this.options.interceptDidChangeWatchedFile ?? false)
    })
    this.serverCapabilities = new WatchableServerCapabilities(initializationResult.capabilities)
    this.serverCapabilities.onRegistrationRequest((request) => {
      for (const registration of request.registrations) {
        if (registration.method === DidOpenTextDocumentNotification.method) {
          const options: TextDocumentRegistrationOptions = registration.registerOptions
          for (const document of this.currentDocuments.values()) {
            if (matchDocument(options.documentSelector, document)) {
              this.sendDidOpenNotification(document).catch(error => {
                this.options.logger?.error('Unable to send notification to server', error)
              })
            }
          }
        }
      }
    })
    this.serverCapabilities.onDidWatchedFileChanged((watchers) => {
      this._onDidWatchedFileChanged.fire(watchers)
    })

    await connection.sendNotification(InitializedNotification.type, {})

    const synchronizeConfigurationSections = this.options.synchronizeConfigurationSections
    if (synchronizeConfigurationSections != null && synchronizeConfigurationSections.length > 0) {
      const synchronizedConfiguration = synchronizeConfigurationSections.reduce((config, section) => {
        setValueBySection(config, section, this.options.getConfiguration?.(section))
        return config
      }, {})

      await connection.sendNotification(DidChangeConfigurationNotification.type, {
        settings: synchronizedConfiguration
      })
    }

    return connection
  }

  public getLogMessages (): LogMessageParams[] {
    return this.logMessages
  }

  private async sendDidOpenNotification (document: TextDocument) {
    const textDocumentItem = TextDocumentItem.create(document.uri, document.languageId, document.version, document.getText())
    await this.connection!.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: textDocumentItem
    })
  }

  private openDocument (document: TextDocument) {
    if (this.isDocumentOpen(document.uri)) {
      return
    }
    const serverCapabilities = this.serverCapabilities!
    const newTextDocument = TextDocument.create(document.uri, document.languageId, 1, document.getText())
    this.currentDocuments.set(document.uri, newTextDocument)
    if (serverCapabilities.getTextDocumentNotificationOptions(DidOpenTextDocumentNotification.type, newTextDocument) != null) {
      this.sendDidOpenNotification(newTextDocument).catch(error => {
        this.options.logger?.error('Unable to send notification to server', error)
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

    const textDocumentChangeOptions = serverCapabilities.getTextDocumentNotificationOptions(DidChangeTextDocumentNotification.type, currentDocument)
    const contentChanges = textDocumentChangeOptions != null && textDocumentChangeOptions.syncKind === TextDocumentSyncKind.Incremental
      ? lspDiffWithTimeout(currentDocument.getText(), newCode)
      : [{
          text: newCode
        }]

    const newDocument = TextDocument.update(currentDocument, contentChanges, currentDocument.version + 1)

    const serverConnection = this.connection!
    if (textDocumentChangeOptions != null && textDocumentChangeOptions.syncKind !== TextDocumentSyncKind.None) {
      serverConnection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: {
          uri: newDocument.uri,
          version: newDocument.version
        },
        contentChanges
      }).catch(error => {
        this.options.logger?.error('Unable to send notification to server', error)
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
    const textDocumentCloseOptions = serverCapabilities.getTextDocumentNotificationOptions(DidCloseTextDocumentNotification.type, currentDocument)
    const serverConnection = this.connection!
    if (textDocumentCloseOptions != null) {
      serverConnection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: TextDocumentIdentifier.create(document.uri)
      }).catch(error => {
        this.options.logger?.error('Unable to send notification to server', error)
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
        this.sendDidSaveNotification(e.document).catch(error => {
          this.options.logger?.error('Unable to send notification to server', error)
        })
      }))
      disposableCollection.push(documents.onWillSave(e => {
        this.sendWillSaveNotification(e.document, e.reason).catch(error => {
          this.options.logger?.error('Unable to send notification to server', error)
        })
      }))
    }

    return disposableCollection
  }

  public async sendWillSaveNotification (document: TextDocument, reason: TextDocumentSaveReason): Promise<void> {
    const serverCapabilities = this.serverCapabilities!
    const serverConnection = this.connection!
    const saveOptions = serverCapabilities.getTextDocumentNotificationOptions(WillSaveTextDocumentNotification.type, document)
    if (saveOptions != null) {
      await serverConnection.sendNotification(WillSaveTextDocumentNotification.type, {
        textDocument: {
          uri: document.uri
        },
        reason
      })
    }
  }

  public async sendWillSaveWaitUntil (document: TextDocument, reason: TextDocumentSaveReason): Promise<TextEdit[] | null> {
    const serverCapabilities = this.serverCapabilities!
    const serverConnection = this.connection!
    const willSaveWaitUntilOptions = serverCapabilities.getTextDocumentNotificationOptions(WillSaveTextDocumentWaitUntilRequest.type, document)
    if (willSaveWaitUntilOptions != null) {
      return await serverConnection.sendRequest(WillSaveTextDocumentWaitUntilRequest.type, {
        textDocument: {
          uri: document.uri
        },
        reason
      })
    }

    return null
  }

  public async sendDidSaveNotification (document: TextDocument): Promise<void> {
    const serverCapabilities = this.serverCapabilities!
    const serverConnection = this.connection!
    const saveOptions = serverCapabilities.getTextDocumentNotificationOptions(DidSaveTextDocumentNotification.type, document)
    if (saveOptions != null) {
      const includeText = saveOptions.includeText ?? false
      await serverConnection.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: {
          uri: document.uri
        },
        text: includeText ? document.getText() : undefined
      })
    }
  }

  public async notifyFileChanges (events: FileEvent[]): Promise<void> {
    if (!(this.options.interceptDidChangeWatchedFile ?? false)) {
      throw new Error('interceptDidChangeWatchedFile should be true to be able to notify file changes')
    }
    const serverCapabilities = this.serverCapabilities
    if (serverCapabilities == null) {
      // The server is not started yet
      return
    }
    const changes = events.filter(event => serverCapabilities.isPathWatched(event.uri, event.type))
    if (changes.length > 0) {
      await this.getServerConnection().sendNotification(DidChangeWatchedFilesNotification.type, {
        changes
      })
    }
  }

  public getFileSystemWatchers (): FileSystemWatcher[] {
    return this.serverCapabilities?.getFileSystemWatchers() ?? []
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
