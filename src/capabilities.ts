import {
  Disposable, Emitter, Event, Registration, RegistrationParams, RegistrationRequest, RegistrationType,
  UnregistrationParams, UnregistrationRequest
} from 'vscode-languageserver'
import {
  ClientCapabilities, DidChangeTextDocumentNotification, DidChangeWatchedFilesNotification, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  FileChangeType,
  FileSystemWatcher,
  ProtocolNotificationType,
  SaveOptions,
  ServerCapabilities, TextDocumentRegistrationOptions, TextDocumentSaveRegistrationOptions, TextDocumentSyncKind, TextDocumentSyncOptions, WillSaveTextDocumentNotification, WillSaveTextDocumentWaitUntilRequest, WorkspaceFoldersRequest
} from 'vscode-languageserver-protocol'
import * as rpc from 'vscode-jsonrpc'
import winston from 'winston'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { matchDocument, matchFileSystemEventKind, testGlobPattern } from './tools/lsp'
import { DisposableCollection } from './tools/disposable'

export function isNumber (value: unknown): value is number {
  return typeof value === 'number' || value instanceof Number
}
// comes from https://github.com/microsoft/vscode-languageserver-node/blob/756cf416e98bc9ce843416cf1c03881ddd1ef322/client/src/common/client.ts#L3322
export function resolveTextDocumentSync (textDocumentSync?: TextDocumentSyncOptions | TextDocumentSyncKind): TextDocumentSyncOptions | undefined {
  if (isNumber(textDocumentSync)) {
    if (textDocumentSync === TextDocumentSyncKind.None) {
      return {
        openClose: false,
        change: TextDocumentSyncKind.None,
        save: undefined
      }
    } else {
      return {
        openClose: true,
        change: textDocumentSync,
        save: {
          includeText: false
        }
      }
    }
  }
  return textDocumentSync
}

export function transformServerCapabilities<T> (serverCapabilities: ServerCapabilities<T>, disableSaveNotifications: boolean): ServerCapabilities<T> {
  const textDocumentSync = resolveTextDocumentSync(serverCapabilities.textDocumentSync)
  return {
    ...serverCapabilities,
    textDocumentSync: {
      ...(textDocumentSync ?? {}),
      save: disableSaveNotifications ? undefined : textDocumentSync?.save,
      openClose: true,
      willSaveWaitUntil: disableSaveNotifications ? false : textDocumentSync?.willSaveWaitUntil,
      willSave: false,
      change: TextDocumentSyncKind.Incremental
    },
    workspace: {
      workspaceFolders: {
        supported: false
      }
    }
  }
}

export function transformClientCapabilities (capabilities: ClientCapabilities): ClientCapabilities {
  return capabilities
}

export function adaptRegistration (registration: Registration): Registration {
  return registration
}

const IGNORED_REGISTRATION_METHOD = new Set([
  DidChangeTextDocumentNotification.method,
  DidOpenTextDocumentNotification.method,
  DidCloseTextDocumentNotification.method,
  WorkspaceFoldersRequest.type.method
])
export function synchronizeLanguageServerCapabilities (
  watchableServerCapabilities: WatchableServerCapabilities,
  clientConnection: rpc.MessageConnection,
  logger?: winston.Logger
): Disposable {
  const disposableCollection = new DisposableCollection()
  try {
    // Synchronizing dynamic server capabilities
    const sendRegistrationRequest = (registrations: readonly Registration[]) => {
      clientConnection.sendRequest(RegistrationRequest.type, {
        registrations: registrations.filter(r => !IGNORED_REGISTRATION_METHOD.has(r.method)).map(adaptRegistration)
      }).catch(error => {
        logger?.error('Unable to send registration requestion to client', { error })
      })
    }
    const registrationRequests = watchableServerCapabilities.getRegistrationRequests()
    if (registrationRequests.length > 0) {
      sendRegistrationRequest(registrationRequests)
    }
    disposableCollection.push(watchableServerCapabilities.onRegistrationRequest(async (params: RegistrationParams) => {
      sendRegistrationRequest(params.registrations)
    }))
    disposableCollection.push(watchableServerCapabilities.onUnregistrationRequest(async (params: UnregistrationParams) => {
      try {
        await clientConnection.sendRequest(UnregistrationRequest.type, params)
      } catch (error) {
        logger?.error('Unable to send unregistration requestion to client', { error })
      }
    }))

    return disposableCollection
  } catch (err) {
    disposableCollection.dispose()
    throw err
  }
}

function resolveSaveOptions (save?: boolean | SaveOptions): TextDocumentSaveRegistrationOptions | undefined {
  if (typeof save === 'boolean') {
    return save
      ? {
          includeText: false,
          documentSelector: null
        }
      : undefined
  }
  return {
    ...save,
    documentSelector: null
  }
}

function getStaticRegistrationOptions<R> (notifType: RegistrationType<R>, sync: TextDocumentSyncOptions): R | undefined {
  switch (notifType.method) {
    case DidOpenTextDocumentNotification.method:
    case DidCloseTextDocumentNotification.method: {
      return ((sync.openClose ?? false) ? { documentSelector: null } : undefined) as unknown as R
    }
    case DidChangeTextDocumentNotification.method: {
      return (sync.change != null ? ({ documentSelector: null, syncKind: sync.change }) : undefined) as unknown as R
    }
    case DidSaveTextDocumentNotification.method: {
      return resolveSaveOptions(sync.save) as unknown as R
    }
    case WillSaveTextDocumentNotification.method: {
      return ((sync.willSave ?? false) ? { documentSelector: null } : undefined) as unknown as R
    }
    case WillSaveTextDocumentWaitUntilRequest.method: {
      return ((sync.willSaveWaitUntil ?? false) ? { documentSelector: null } : undefined) as unknown as R
    }
  }
}

export class WatchableServerCapabilities {
  private capabilities: ServerCapabilities<void>
  private registrationRequests: Registration[]

  private _onRegistrationRequest = new Emitter<RegistrationParams>()
  private _onUnregistrationRequest = new Emitter<UnregistrationParams>()
  private _onDidWatchedFileChanged = new Emitter<FileSystemWatcher[]>()

  constructor (capabilities: ServerCapabilities<void>) {
    this.capabilities = capabilities
    this.registrationRequests = []
  }

  get onRegistrationRequest (): Event<RegistrationParams> {
    return this._onRegistrationRequest.event
  }

  get onUnregistrationRequest (): Event<UnregistrationParams> {
    return this._onUnregistrationRequest.event
  }

  get onDidWatchedFileChanged (): Event<FileSystemWatcher[]> {
    return this._onDidWatchedFileChanged.event
  }

  public handleRegistrationRequest (params: RegistrationParams): void {
    // Hack for C#
    const existingRegistrationIds = new Set(this.registrationRequests.map(r => r.id))
    const registrations = params.registrations.filter(r => !existingRegistrationIds.has(r.id))

    if (registrations.length > 0) {
      this.registrationRequests.push(...registrations)
      this._onRegistrationRequest.fire({
        ...params,
        registrations
      })
      if (registrations.some(registration => registration.method === DidChangeWatchedFilesNotification.type.method)) {
        this._onDidWatchedFileChanged.fire(this.getFileSystemWatchers())
      }
    }
  }

  public handleUnregistrationRequest (params: UnregistrationParams): void {
    const existingRegistrationIds = new Set(this.registrationRequests.map(r => r.id))
    const removedRegistrations = params.unregisterations.filter(u => existingRegistrationIds.has(u.id))
    const removedRegistrationIds = new Set(params.unregisterations.map(unregistration => unregistration.id))
    this.registrationRequests = this.registrationRequests.filter(registration => !removedRegistrationIds.has(registration.id))
    this._onUnregistrationRequest.fire({
      ...params,
      unregisterations: removedRegistrations
    })
    if (removedRegistrations.some(registration => registration.method === DidChangeWatchedFilesNotification.type.method)) {
      this._onDidWatchedFileChanged.fire(this.getFileSystemWatchers())
    }
  }

  public getCapabilities (): ServerCapabilities<void> {
    return this.capabilities
  }

  public getRegistrationRequests (): readonly Registration[] {
    return this.registrationRequests
  }

  private getDynamicRegistrations<O> (request: RegistrationType<O>): Registration[] {
    return this.registrationRequests.filter(r => r.method === request.method)
  }

  public getDynamicRegistrationOptions<O> (request: RegistrationType<O>): O[] {
    return this.getDynamicRegistrations(request).map(item => item.registerOptions)
  }

  private getResolvedDocumentSync (): TextDocumentSyncOptions | undefined {
    return resolveTextDocumentSync(this.capabilities.textDocumentSync)
  }

  public onCapabilityChange (list: ProtocolNotificationType<unknown, unknown>[], cb: () => void): Disposable {
    const methods = new Set(list.map(item => item.method))
    return this.onRegistrationRequest(({ registrations }) => {
      if (registrations.some(registration => methods.has(registration.method))) {
        cb()
      }
    })
  }

  public getTextDocumentNotificationOptions<R extends TextDocumentRegistrationOptions> (
    messageType: RegistrationType<R>,
    document: TextDocument
  ): R | undefined {
    const textDocumentSync = this.getResolvedDocumentSync()
    const staticRegistration = textDocumentSync != null ? getStaticRegistrationOptions(messageType, textDocumentSync) : undefined
    if (staticRegistration != null) {
      return staticRegistration
    }
    const options = this.getDynamicRegistrationOptions(messageType)
    for (const option of options) {
      if (matchDocument(option.documentSelector, document)) {
        return option
      }
    }
  }

  public getFileSystemWatchers (): FileSystemWatcher[] {
    return this.getDynamicRegistrationOptions(DidChangeWatchedFilesNotification.type).flatMap(options => options.watchers)
  }

  public isPathWatched (path: string, type: FileChangeType): boolean {
    for (const watcher of this.getFileSystemWatchers()) {
      if ((matchFileSystemEventKind(watcher.kind ?? 7, type)) && testGlobPattern(watcher.globPattern, path)) {
        return true
      }
    }
    return false
  }

  public isUriWatched (uri: string, type: FileChangeType): boolean {
    const url = new URL(uri)
    if (url.protocol !== 'file') {
      return false
    }
    return this.isPathWatched(url.pathname, type)
  }
}
