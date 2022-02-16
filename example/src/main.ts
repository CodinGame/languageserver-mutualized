import 'monaco-editor-core'
import * as monaco from 'monaco-editor-core'

declare global {
  interface Window extends monaco.Window {
  }
}

window.MonacoEnvironment = {
  getWorkerUrl: () => './editor.worker.bundle.js'
}
import('./client')
