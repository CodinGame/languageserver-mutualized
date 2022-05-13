import fastDiff from 'fast-diff'
import { InitializeParams } from 'vscode-languageserver'
import { DocumentFilter, DocumentSelector, FileChangeType, GlobPattern, Position, RelativePattern, RequestType, TextDocumentContentChangeEvent, TextDocumentFilter, URI } from 'vscode-languageserver-protocol'
import globToRegExp from 'glob-to-regexp'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { pathToFileURL, URL } from 'url'
interface Diff {
  offset: number
  length: number
  text: string
}

function diff (oldText: string, newText: string): Diff[] {
  const diffsResult = fastDiff(oldText, newText)

  let offset = 0
  const diffs: Diff[] = []
  for (const [type, text] of diffsResult) {
    switch (type) {
      case -1:
        diffs.push({
          offset,
          length: text.length,
          text: ''
        })
        break
      case 1:
        diffs.push({
          offset,
          length: 0,
          text
        })
        break
    }
    if (type !== 1) {
      offset += text.length
    }
  }
  return diffs
}

function optimizeDiff (diffs: Diff[]): Diff[] {
  const optimizedDiff: Diff[] = []
  let lastDiff = diffs[0]
  for (let i = 1; i < diffs.length; ++i) {
    const diff = diffs[i]!
    if (diff.offset === lastDiff!.offset + lastDiff!.length) {
      lastDiff = {
        offset: lastDiff!.offset,
        length: lastDiff!.length + diff.length,
        text: lastDiff?.text + diff.text
      }
    } else {
      optimizedDiff.push(lastDiff!)
      lastDiff = diff
    }
  }
  if (lastDiff != null) {
    optimizedDiff.push(lastDiff)
  }
  return optimizedDiff
}

function charOffsetToLineAndChar (lines: string[], offset: number): Position {
  for (let i = 0; i < lines.length; i++) {
    if (offset <= lines[i]!.length) {
      return { line: i, character: offset }
    }
    offset -= lines[i]!.length + 1 // +1 for newline char
  }
  throw new Error(`Position ${offset} not found in lines: ${lines.join('\n')}`)
}

export function lspDiff (oldText: string, newText: string): TextDocumentContentChangeEvent[] {
  const diffs = diff(oldText, newText)
  const optimized = optimizeDiff(diffs)

  const oldLines = oldText.split('\n')
  return optimized.slice(0).reverse().map(diff => ({
    range: {
      start: charOffsetToLineAndChar(oldLines, diff.offset),
      end: charOffsetToLineAndChar(oldLines, diff.offset + diff.length)
    },
    rangeLength: diff.length,
    text: diff.text
  }))
}

export function getClientWorkspaceFolderUri (initParams: InitializeParams): string {
  if (initParams.workspaceFolders != null && initParams.workspaceFolders.length > 0) {
    return initParams.workspaceFolders[0]!.uri
  }
  if (initParams.rootUri != null) {
    return initParams.rootUri
  }
  if (initParams.rootPath != null) {
    return pathToFileURL(initParams.rootPath).toString()
  }
  throw new Error('No workspace folder configured')
}

export function isRequestType<P, R> (type: RequestType<P, R, unknown>, request: RequestType<unknown, unknown, unknown>, params: unknown): params is P {
  return request.method === type.method
}

export function testGlob (pattern: string, value: string): boolean {
  const regExp = globToRegExp(pattern, {
    extended: true,
    globstar: true
  })
  return regExp.test(value)
}

const sep = process.platform === 'win32' ? '\\' : '/'
export function isEqualOrParent (base: string, parentCandidate: string, separator = sep): boolean {
  if (base === parentCandidate) {
    return true
  }

  if (parentCandidate.length > base.length) {
    return false
  }

  if (parentCandidate.charAt(parentCandidate.length - 1) !== separator) {
    parentCandidate += separator
  }

  return base.indexOf(parentCandidate) === 0
}

export function testGlobPattern (globPattern: GlobPattern, pathname: string): boolean {
  if (RelativePattern.is(globPattern)) {
    const uri = URI.is(globPattern.baseUri) ? globPattern.baseUri : globPattern.baseUri.uri
    const parsedUrl = new URL(uri, 'http://lsp.codingame.com')
    const parentPath = parsedUrl.pathname
    if (!isEqualOrParent(pathname, parentPath)) {
      return false
    }
    return testGlob(globPattern.pattern, pathname.substr(parentPath.length + 1))
  } else {
    return testGlob(globPattern, pathname)
  }
}

export function matchDocument (selector: string | DocumentFilter | DocumentSelector | null, document: TextDocument): boolean {
  if (selector == null) {
    return true
  }
  if (Array.isArray(selector)) {
    return selector.some(filter => matchDocument(filter, document))
  }
  if (TextDocumentFilter.is(selector)) {
    if (selector.language != null && selector.language !== document.languageId) {
      return false
    }
    const url = new URL(document.uri)
    const scheme = url.protocol.slice(0, -1)
    if (selector.scheme != null && selector.scheme !== scheme) {
      return false
    }
    if (selector.pattern != null && !testGlobPattern(selector.pattern, url.pathname)) {
      return false
    }
    return true
  }
  return selector === document.languageId
}

export function matchFileSystemEventKind (kind: number, type: FileChangeType): boolean {
  switch (type) {
    case FileChangeType.Created: return (kind & 0b001) > 0
    case FileChangeType.Changed: return (kind & 0b010) > 0
    case FileChangeType.Deleted: return (kind & 0b100) > 0
  }
}
