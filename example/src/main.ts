import 'monaco-editor'
import * as monaco from 'monaco-editor'

declare global {
  interface Window extends monaco.Window {
  }
}

window.MonacoEnvironment = {
  getWorkerUrl: () => './editor.worker.js'
}
import('./client')
