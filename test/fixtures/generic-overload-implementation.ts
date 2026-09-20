// An overloaded generic FUNCTION DECLARATION: every call resolves to one of
// the signature-only overloads, but the body that has to be walked belongs to
// the implementation declaration behind them.
export function some<T>(array: readonly T[] | undefined): array is readonly T[]
export function some<T>(array: readonly T[] | undefined, predicate: (value: T) => boolean): boolean
export function some<T>(array: readonly T[] | undefined, predicate?: (value: T) => boolean): boolean {
  if (array) {
    if (predicate) {
      for (const v of array) {
        if (predicate(v)) return true
      }
    } else {
      return array.length > 0
    }
  }
  return false
}

const numbers = [1, 2, 3]
const names = ['a', 'b']
console.log(
  some(numbers),
  some(numbers, (v) => v > 2),
  some(names, (s) => s === 'b')
)
