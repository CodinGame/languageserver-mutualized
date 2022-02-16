/* --------------------------------------------------------------------------------------------
 * Copyright (c) 2018 TypeFox GmbH (http://www.typefox.io). All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import ws from 'ws'
import express from 'express'
import * as rpc from '@codingame/monaco-jsonrpc'
import * as http from 'http'
import net from 'net'
import { launch } from './json-server-launcher'

process.on('uncaughtException', function (err: Error) {
  console.error('Uncaught Exception: ', err.toString())
  if (err.stack != null) {
    console.error(err.stack)
  }
})

// create the express application
const app = express()
// server the static content, i.e. index.html
app.use(express.static(__dirname))
// start the server
const server = app.listen(8000, () => {
  console.log('🚀 Server ready on port 8000')
})
// create the web socket
const wss = new ws.Server({
  noServer: true,
  perMessageDeflate: false
})
const synchronizeSockets: ws[] = []
server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
  const pathname = request.url
  if (pathname === '/sampleServer') {
    wss.handleUpgrade(request, socket, head, webSocket => {
      const socket: rpc.IWebSocket = {
        send: content => webSocket.send(content, error => {
          if (error != null) {
            throw error
          }
        }),
        onMessage: cb => webSocket.on('message', cb),
        onError: cb => webSocket.on('error', cb),
        onClose: cb => webSocket.on('close', cb),
        dispose: () => webSocket.close()
      }
      // launch the server when the web socket is opened
      if (webSocket.readyState === webSocket.OPEN) {
        launch(socket).catch(error => {
          console.error(error)
        })
      } else {
        webSocket.on('open', () => launch(socket).catch(error => {
          console.error(error)
        }))
      }
    })
  } else if (pathname === '/synchronize') {
    wss.handleUpgrade(request, socket, head, webSocket => {
      if (webSocket.readyState === webSocket.OPEN) {
        synchronizeSockets.push(webSocket)
      } else {
        webSocket.on('open', () => {
          synchronizeSockets.push(webSocket)
        })
      }
      webSocket.on('close', () => {
        const index = synchronizeSockets.indexOf(webSocket)
        synchronizeSockets.splice(index, 1)
      })
      webSocket.on('message', message => {
        for (const socket of synchronizeSockets) {
          if (socket !== webSocket) {
            socket.send(message)
          }
        }
      })
    })
  }
})
