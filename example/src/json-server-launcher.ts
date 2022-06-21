import * as rpc from '@codingame/monaco-jsonrpc'
import { createMessageConnection } from 'vscode-languageserver/lib/node/main'
import { bindLanguageClient, createLanguageClient } from '@codingame/languageserver-mutualized'
import * as path from 'path'
import cp from 'child_process'

// Start the server once
const extJsonServerPath = path.resolve(__dirname, 'ext-json-server.ts')
const serverProcess = cp.spawn('node', ['--loader', 'ts-node/esm', extJsonServerPath])
serverProcess.on('error', error => console.error(`Launching Server failed: ${error}`))
serverProcess.stderr.on('data', data => console.error(`Server error: ${data}`))

const languageClient = createLanguageClient(createMessageConnection(serverProcess.stdout, serverProcess.stdin), {})
console.log('Language server started')

export async function launch (socket: rpc.IWebSocket): Promise<void> {
  const reader = new rpc.WebSocketMessageReader(socket)
  const writer = new rpc.WebSocketMessageWriter(socket)

  const messageConnection = createMessageConnection(reader, writer)
  socket.onClose(() => {
    messageConnection.dispose()
  })

  console.log('Binding new client to existing language server')
  // Only bind the client on the server
  await bindLanguageClient(languageClient, messageConnection, {})
}
