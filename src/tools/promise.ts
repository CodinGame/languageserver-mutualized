import delay from 'delay'

export class TimeoutError extends Error {
  constructor (message: string = 'Timeout') {
    super(message)
  }
}

export async function timeout<T> (timeout: number, promise: Promise<T>, error: Error = new TimeoutError()): Promise<T> {
  const timeoutPromise = delay.reject(timeout, {
    value: error
  })
  try {
    return await Promise.race([
      promise,
      timeoutPromise
    ])
  } finally {
    timeoutPromise.clear()
  }
}
