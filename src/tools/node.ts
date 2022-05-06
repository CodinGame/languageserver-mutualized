import vm from 'vm'

declare global {
  function compute (): void
}

export function runWithTimeout<T> (fct: () => T, timeout: number = 1000): T {
  let result: T | null = null
  function compute () {
    result = fct()
  }
  global.compute = compute
  vm.runInThisContext('compute()', { timeout })
  return result!
}
