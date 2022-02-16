import * as rpc from '@codingame/monaco-jsonrpc'
import { CancellationToken, MessageSignature } from '@codingame/monaco-jsonrpc'
import objectHash from 'object-hash'
import { forwardedClientRequests } from '../constants/lsp'

export interface ConnectionRequestCache {
  get: (key: string) => unknown | null
  set: (key: string, value: unknown) => void
  reset: () => void
}

const cachedRequestMethods = new Set(forwardedClientRequests.map(request => request.method))

export function createMemoizedConnection (connection: rpc.MessageConnection, cache: ConnectionRequestCache): rpc.MessageConnection {
  return {
    ...connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendRequest: (methodOrType: string | MessageSignature, ...args: any[]) => {
      const method = typeof methodOrType === 'string' ? methodOrType : methodOrType.method

      if (!cachedRequestMethods.has(method)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return connection.sendRequest(methodOrType as any, ...args)
      }

      const realArgs = CancellationToken.is(args[args.length - 1]) ? args.slice(0, -1) : args

      const cacheKey = objectHash({
        method,
        args: realArgs
      })
      const cacheValue = cache.get(cacheKey)
      if (cacheValue != null) {
        return cacheValue
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultPromise = connection.sendRequest(methodOrType as any, ...args) as any
      cache.set(cacheKey, resultPromise)
      return resultPromise
    }
  }
}
