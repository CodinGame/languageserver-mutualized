import { Disposable, HandlerResult, ProtocolRequestType, ProtocolRequestType0, RequestHandler } from 'vscode-languageserver'

export type RequestHandlerRegistration<T, R, E> = (handler: RequestHandler<T, R | null, E>) => Disposable
export function allVoidMerger<E> (results: Awaited<HandlerResult<null | void, E>>[]): HandlerResult<void, E> {
  for (const result of results) {
    if (result instanceof Error) {
      return result
    }
  }
}

export function singleHandlerMerger<R, E> (errorResponse?: R) {
  return (results: Awaited<HandlerResult<R | null, E>>[]): R => {
    const validResults = results.filter((result): result is Awaited<R> => result != null)
    if (validResults.length !== 1) {
      if (errorResponse == null) {
        throw new Error(`Expected 1 answer, got ${validResults.length}`)
      }
      return errorResponse
    }
    return validResults[0]!
  }
}

export class MultiRequestHandler<T, R, E> {
  private handlers: RequestHandler<T, R | null, E>[] = []
  constructor (
    type: ProtocolRequestType<T, R, unknown, E, void> | ProtocolRequestType0<T, unknown, E, void>,
    private merger: (results: Awaited<HandlerResult<R | null, E>>[]) => HandlerResult<R, E>
  ) {
  }

  public onRequest: RequestHandlerRegistration<T, R, E> = handler => {
    this.handlers.push(handler)
    return Disposable.create(() => {
      const index = this.handlers.indexOf(handler)
      if (index >= 0) {
        this.handlers.splice(index, 1)
      }
    })
  }

  public sendRequest: RequestHandler<T, R, E> = async (params, token) => {
    return this.merger(await Promise.all(this.handlers.map(async handler => {
      return await handler(params, token)
    })))
  }
}
