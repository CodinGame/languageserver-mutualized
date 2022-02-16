import { listen } from '@codingame/monaco-jsonrpc'
import * as monaco from 'monaco-editor-core'
import {
  MonacoLanguageClient, MessageConnection, CloseAction, ErrorAction,
  MonacoServices, createConnection
} from '@codingame/monaco-languageclient'
import normalizeUrl from 'normalize-url'

// register Monaco languages
monaco.languages.register({
  id: 'json',
  extensions: ['.json', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc'],
  aliases: ['JSON', 'json'],
  mimetypes: ['application/json']
})

// create Monaco editor
const value = `{
    "$schema": "http://json.schemastore.org/coffeelint",
    "line_endings": "unix"
}`
const synchronizeWebSocket = createWebSocket(createUrl('/synchronize'))
const editor = monaco.editor.create(document.getElementById('container1')!, {
  model: monaco.editor.createModel(value, 'json', monaco.Uri.parse('inmemory://model.json')),
  glyphMargin: true,
  lightbulb: {
    enabled: true
  }
})
editor.onDidChangeModelContent(() => {
  synchronizeWebSocket.send(editor.getModel()!.getValue())
})
synchronizeWebSocket.onmessage = message => {
  message.data.text().then((text: string) => {
    if (text !== editor.getModel()!.getValue()) {
      editor.getModel()!.setValue(text)
    }
  })
}

monaco.editor.create(document.getElementById('container2')!, {
  model: monaco.editor.createModel(value, 'json', monaco.Uri.parse(`inmemory://model-${(Math.random() * 1000).toFixed(0)}.json`)),
  glyphMargin: true,
  lightbulb: {
    enabled: true
  }
})

// install Monaco language client services
MonacoServices.install(monaco)

// create the web socket
const webSocket = createWebSocket(createUrl('/sampleServer'))
// listen when the web socket is opened
listen({
  webSocket,
  onConnection: connection => {
    // create and start the language client
    const languageClient = createLanguageClient(connection)
    const disposable = languageClient.start()
    connection.onClose(() => disposable.dispose())
  }
})

function createLanguageClient (connection: MessageConnection): MonacoLanguageClient {
  return new MonacoLanguageClient({
    name: 'Sample Language Client',
    clientOptions: {
      // use a language id as a document selector
      documentSelector: ['json'],
      // disable the default error handler
      errorHandler: {
        error: () => ErrorAction.Continue,
        closed: () => CloseAction.DoNotRestart
      }
    },
    // create a language client connection from the JSON RPC connection on demand
    connectionProvider: {
      get: (errorHandler, closeHandler) => {
        return Promise.resolve(createConnection(connection, errorHandler, closeHandler))
      }
    }
  })
}

function createUrl (path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return normalizeUrl(`${protocol}://${window.location.hostname}:8000${path}`)
}

function createWebSocket (url: string) {
  return new window.WebSocket(url, [])
}
