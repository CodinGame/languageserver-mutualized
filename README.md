# @codingame/languageserver-mutualized &middot; [![monthly downloads](https://img.shields.io/npm/dm/@codingame/languageserver-mutualized)](https://www.npmjs.com/package/@codingame/languageserver-mutualized) [![npm version](https://img.shields.io/npm/v/@codingame/languageserver-mutualized.svg?style=flat)](https://www.npmjs.com/package/@codingame/languageserver-mutualized) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/codingame/languageserver-mutualized/pulls)

[NPM module](https://www.npmjs.com/) to plug multiple language clients on a single language server.

What you need to know:
- Only initialization request of the first client will be used, so it's a good idea for all client to have the exact same capabilities and initialize params
- Some features won't work (configuration requests, execute command server request...)

What it allows you to do:
- Plug clients on different independant files
- Plug clients on the same files, then you need to synchronize the content of the editor between clients

How it works:
- If a file is open by at least one client, it's open on the server
- Every time a client change the content of a file, we stack their changes and flush it after 500ms of inactivity
- As soon a there is a request from this client, we flush their changes and then forward the request to the server
- Every time the server sends a diagnostics notification, it's forwarded to the clients having this file open


### Installation

```bash
npm install @codingame/languageserver-mutualized 
```

### Usage

2 functions are exported:
- `createLanguageClient` which create a `LanguageClient` from a language server connection
- `bindLanguageClient` which bind a client connection on an existing `LanguageClient` and return a promise resolved when the client leaves or the server is shutdown


### Examples

There is an example that demonstrate how the languageserver-mutualized can be used.
It uses [monaco-editor](https://github.com/microsoft/monaco-editor) and [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient).

The important file is [json-server-launcher.ts](https://github.com/CodinGame/languageserver-mutualized/blob/main/example/src/json-server-launcher.ts)

To run it:
```bash
npm ci
npm start
```

It will open a page in your browser with 2 editors to illustrate the 2 use-cases:
- The first editor is synchronized between all clients and use the same file uri
- The second editor use a random file uri and is not synchronized


### Advanced users

#### Cache

After a change, most clients send some requests (SemanticTokens, CodeLens...). If a file is used by multiple clients, every client will send the request and the server will need to answer it multiple times.

To prevent this, a cache can be provided when creating the `LanguageClient`

#### Configuration

The configuration coming from the client cannot be used. However, some language servers requires some configuration to work.

The configuration can be provided using the `getConfiguration` LanguageClient option.

It will be called when:
- The language server sends a `workspace/configuration` request (the scope will be ignored)
- When providing the `synchronizeConfigurationSections` option (old deprecated way but still used by many language servers)
