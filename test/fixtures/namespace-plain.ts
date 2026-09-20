export namespace Debug {
  export function assert(expression: boolean, message?: string): void {
    if (!expression) throw new Error(message ?? 'assertion failed')
  }
  export let level = 0
}
const values: number[] = [1, 2, 3]
Debug.assert(values.length === 3, 'three')
Debug.level = 2
console.log(Debug.level)
