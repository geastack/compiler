//! expect: lookups=7,-,9,-,11,5
//! expect: after=-,12,13
//! expect: equal=true,false,false,true
//! expect: elements=1.5,2.5,-,3,0
// Two hot three.js read shapes, answered with one lookup or inline:
// - WebGLUniforms/WebGLMaterials read a material property table under
//   `noUncheckedIndexedAccess` as `table[key]`, present or `undefined`. A
//   plain table answers presence and value with one lookup; the result must
//   still be the language's, for present, absent, deleted and re-added keys
//   and for the table's first entry.
// - `arraysEqual(a, b)` reads `b[i]` where `b` is `number[] | Float32Array`:
//   an Array arm's integral in-range index answers its cell directly, and any
//   other index (a hole, -0, out of range) keeps the checked semantics.

interface Uniform {
  value: number
}

const table: Record<string, Uniform> = {}
table.first = { value: 7 }
table.second = { value: 9 }
table.third = { value: 11 }
table.fourth = { value: 5 }

function lookup(name: string): string {
  const found = table[name]
  return found === undefined ? '-' : String(found.value)
}

console.log('lookups=' + ['first', 'missing', 'second', 'secon', 'third', 'fourth'].map(lookup).join(','))
delete table.first
table.fifth = { value: 13 }
table.second = { value: 12 }
console.log('after=' + ['first', 'second', 'fifth'].map(lookup).join(','))

function arraysEqual(a: number[], b: number[] | Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0, l = a.length; i < l; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const cache = [1, 2, 3]
const typed = new Float32Array([1, 2, 3])
console.log(
  'equal=' +
    [arraysEqual(cache, [1, 2, 3]), arraysEqual(cache, [1, 2, 4]), arraysEqual(cache, [1, 2]), arraysEqual(cache, typed)].join(',')
)

function readAt(values: number[] | Float32Array, index: number): string {
  const value = values[index]
  return value === undefined ? '-' : String(value)
}

const sparse: number[] = [1.5, 2.5]
sparse[3] = 3
const negativeZero = -0
console.log(
  'elements=' +
    [readAt(sparse, 0), readAt(sparse, 1), readAt(sparse, 2), readAt(sparse, 3), readAt(new Float32Array([0, 1]), negativeZero)].join(',')
)
