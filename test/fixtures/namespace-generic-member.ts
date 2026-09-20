// A source namespace whose members include a generic function, called through
// the namespace path. TypeScript's own `Debug` namespace: every
// `Debug.assert(...)` in the compiler reads `Debug` as a value first.
export namespace Debug {
  export function assert(expression: boolean, message?: string): void {
    if (!expression) throw new Error(message ?? 'assertion failed')
  }
  export function checkDefined<T>(value: T | undefined, message?: string): T {
    if (value === undefined) throw new Error(message ?? 'undefined')
    return value
  }
  export function fail(message: string): never {
    throw new Error(message)
  }
}

const values: number[] = [1, 2, 3]
Debug.assert(values.length === 3, 'three')
const last = Debug.checkDefined(values[2])
const name = Debug.checkDefined<string>('x')
console.log(last, name)
if (values.length > 5) Debug.fail('unreachable')
