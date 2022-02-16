export interface DeferredPromise<ValueType> {
  promise: Promise<ValueType>
  resolve(value?: ValueType | PromiseLike<ValueType>): void
  reject(reason?: unknown): void
}

export default function pDefer<ValueType> (): DeferredPromise<ValueType> {
  let _resolve: (value: ValueType | PromiseLike<ValueType>) => void = () => {}
  let _reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<ValueType>((resolve, reject) => {
    _resolve = resolve
    _reject = reject
  })

  return {
    promise,
    resolve: _resolve,
    reject: _reject
  }
}
