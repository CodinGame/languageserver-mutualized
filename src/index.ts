import { BindContext, createLanguageClient, LanguageClient, LanguageClientDisposeReason, LanguageClientOptions } from './language-client'
import { bindLanguageClient, ConnectionClosedError, EndCause, LanguageClientBindingOptions, UnknownRequestHandler } from './language-client-mutualization'
import { ConnectionRequestCache } from './tools/cache'

export { bindLanguageClient, createLanguageClient }

export type {
  LanguageClientDisposeReason,
  LanguageClient,
  LanguageClientOptions,
  LanguageClientBindingOptions,
  UnknownRequestHandler,
  ConnectionClosedError,
  BindContext,
  ConnectionRequestCache,
  EndCause
}