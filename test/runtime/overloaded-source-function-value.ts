//! expect: pad:    a|  b| c
//! expect: some: true,true,false,true
//! emitted-lacks: gea::Value

// An overloaded SOURCE function is one runtime function: its value is the
// implementation's signature (never a boxed "unjoinable overload set"), a
// call resolved through any declared overload is an exact call to that body,
// and a GENERIC implementation is monomorphized per instantiation the calls
// make -- copies keyed on the implementation, not the signature-only overloads.
function pad(value: string): string
function pad(value: string, width: number): string
function pad(value: string, width?: number): string {
  const target = width ?? 4
  let out = value
  while (out.length < target) out = ` ${out}`
  return out
}

function some<T>(array: readonly T[] | undefined): array is readonly T[]
function some<T>(array: readonly T[] | undefined, predicate: (value: T) => boolean): boolean
function some<T>(array: readonly T[] | undefined, predicate?: (value: T) => boolean): boolean {
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

const padder = pad
console.log(`pad: ${pad('a')}|${pad('b', 3)}|${padder('c', 2)}`)
const numbers = [1, 2, 3]
const names = ['a', 'b']
console.log(`some: ${some(numbers)},${some(numbers, (v) => v > 2)},${some(names, (s) => s === 'z')},${some(names, (s) => s.length === 1)}`)
