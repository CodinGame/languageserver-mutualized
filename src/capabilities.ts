import { DisposableCollection } from '@codingame/monaco-jsonrpc'
import {
  Disposable, Emitter, Event, Registration, RegistrationParams, RegistrationRequest, RegistrationType,
  UnregistrationParams, UnregistrationRequest
} from 'vscode-languageserver'
import {
  ClientCapabilities, DidChangeTextDocumentNotification, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
  SaveOptions,
  ServerCapabilities, TextDocumentSyncKind, TextDocumentSyncOptions, WorkspaceFoldersRequest
} from 'vscode-languageserver-protocol'
import * as rpc from '@codingame/monaco-jsonrpc'
import winston from 'winston'

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

export class WatchableServerCapabilities {
  private capabilities: ServerCapabilities<unknown>
  private registrationRequests: Registration[]

  private _onRegistrationRequest = new Emitter<RegistrationParams>()
  private _onUnregistrationRequest = new Emitter<UnregistrationParams>()

  constructor (capabilities: ServerCapabilities<unknown>) {
    this.capabilities = capabilities
    this.registrationRequests = []
  }

  get onRegistrationRequest (): Event<RegistrationParams> {
    return this._onRegistrationRequest.event
  }

  get onUnregistrationRequest (): Event<UnregistrationParams> {
    return this._onUnregistrationRequest.event
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
    }
  }

  public handleUnregistrationRequest (params: UnregistrationParams): void {
    const existingRegistrationIds = new Set(this.registrationRequests.map(r => r.id))
    const removeRegistrations = params.unregisterations.filter(u => existingRegistrationIds.has(u.id))
    const removeRegistrationIds = new Set(params.unregisterations.map(unregistration => unregistration.id))
    this.registrationRequests = this.registrationRequests.filter(registration => !removeRegistrationIds.has(registration.id))
    this._onUnregistrationRequest.fire({
      ...params,
      unregisterations: removeRegistrations
    })
  }

  public getCapabilities (): ServerCapabilities<unknown> {
    return this.capabilities
  }

  public getRegistrationRequests (): readonly Registration[] {
    return this.registrationRequests
  }

  public getDynamicRegistration<O> (request: RegistrationType<O>): Registration | undefined {
    return this.registrationRequests.find(r => r.method === request.method)
  }

  public getDynamicRegistrationOptions<O> (request: RegistrationType<O>): O | undefined {
    return this.getDynamicRegistration(request)?.registerOptions
  }

  public getTextDocumentSyncKind (): TextDocumentSyncKind {
    const syncOpts = this.getCapabilities().textDocumentSync ?? this.getDynamicRegistrationOptions(DidChangeTextDocumentNotification.type)?.syncKind
    if (typeof syncOpts === 'object') {
      return syncOpts.change ?? TextDocumentSyncKind.None
    } else {
      return syncOpts ?? TextDocumentSyncKind.None
    }
  }

  public getResolvedDocumentSync (): TextDocumentSyncOptions | undefined {
    return resolveTextDocumentSync(this.getCapabilities().textDocumentSync)
  }

  public getResolvedDocumentSyncSaveOptions (): SaveOptions | undefined {
    const saveOptions = this.getResolvedDocumentSync()?.save
    if (typeof saveOptions === 'boolean') {
      return saveOptions ? {} : undefined
    } else {
      return saveOptions
    }
  }
}
