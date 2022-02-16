import fastDiff from 'fast-diff'
import { InitializeParams } from 'vscode-languageserver'
import { Position, RequestType, TextDocumentContentChangeEvent } from 'vscode-languageserver-protocol'
import { pathToFileURL } from 'url'

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
