import { SemanticTokensDeltaRequest, SemanticTokensRangeRequest } from 'vscode-languageserver'
import {
  CodeActionRequest, CodeActionResolveRequest, CodeLensRequest, CodeLensResolveRequest, CompletionRequest,
  CompletionResolveRequest, DefinitionRequest, DocumentColorRequest, DocumentDiagnosticRequest, DocumentFormattingRequest, DocumentHighlightRequest, DocumentLinkRequest,
  DocumentLinkResolveRequest, DocumentOnTypeFormattingRequest, DocumentRangeFormattingRequest, ExecuteCommandRequest,
  FoldingRangeRequest, HoverRequest, PrepareRenameRequest, ReferencesRequest, RenameRequest, RequestType, SemanticTokensRequest,
  SignatureHelpRequest, WorkspaceDiagnosticRequest, WorkspaceSymbolRequest, WorkspaceSymbolResolveRequest
} from 'vscode-languageserver-protocol'

export const forwardedClientRequests: RequestType<unknown, unknown, unknown>[] = [
  HoverRequest.type,
  ReferencesRequest.type,
  SignatureHelpRequest.type,
  SemanticTokensRequest.type,
  SemanticTokensDeltaRequest.type,
  SemanticTokensRangeRequest.type,
  DefinitionRequest.type,
  ReferencesRequest.type,
  DocumentHighlightRequest.type,
  WorkspaceSymbolRequest.type,
  DocumentFormattingRequest.type,
  DocumentRangeFormattingRequest.type,
  DocumentOnTypeFormattingRequest.type,
  RenameRequest.type,
  PrepareRenameRequest.type,
  ExecuteCommandRequest.type,
  CompletionRequest.type,
  CompletionResolveRequest.type,
  CodeActionRequest.type,
  CodeActionResolveRequest.type,
  CodeLensRequest.type,
  CodeLensResolveRequest.type,
  DocumentLinkRequest.type,
  DocumentLinkResolveRequest.type,
  FoldingRangeRequest.type,
  DocumentColorRequest.type,
  WorkspaceDiagnosticRequest.type,
  DocumentDiagnosticRequest.type,
  WorkspaceSymbolResolveRequest.type
]
