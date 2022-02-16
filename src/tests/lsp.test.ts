import { TextDocument, TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument'
import { lspDiff } from '../tools/lsp'

function applyDiff (code: string, diff: TextDocumentContentChangeEvent[]) {
  const document = TextDocument.create('file:///test.txt', 'plaintext', 1, code)
  const newDocument = TextDocument.update(document, diff, 2)
  return newDocument.getText()
}

describe('LspDiff', () => {
  test('Simple change', async () => {
    const before = 'public static void main(String a)'
    const after = 'public static void main(String b)'
    const diff = lspDiff(before, after)
    expect(diff).toHaveLength(1)
    expect(applyDiff(before, diff)).toBe(after)
  })

  test('Multiple changes', async () => {
    const before = 'public static void main(String toto)'
    const after = 'private void final compute(String tata)'
    const diff = lspDiff(before, after)
    expect(applyDiff(before, diff)).toBe(after)
  })
})
