// A `for...in` head is a STRING key, and an index through it names the whole
// key set. TypeScript spells the binding `Extract<keyof T, string>`, a
// conditional it defers while `T` is open; a hand-written equivalent has to
// reach the same answer, because the rule asks the checker whether the key is
// a string rather than matching a library alias.
type OwnStringKey<T> = keyof T extends infer K ? (K extends string ? K : never) : never

interface Opts {
  a: number
  b: string
}

function copyInto<T extends object>(target: T, source: T): T {
  for (const key in source) {
    target[key] = source[key]
  }
  return target
}

function readOne<T extends object>(source: T, wanted: OwnStringKey<T>): T[OwnStringKey<T>] {
  return source[wanted]
}

function keysOf<T extends object>(source: T): string[] {
  const names: string[] = []
  for (const key in source) {
    names.push(key)
  }
  return names
}

const filled = copyInto<Opts>({ a: 0, b: '' }, { a: 7, b: 'seven' })
console.log(filled.a, filled.b)
console.log(keysOf<Opts>(filled).join(','))
console.log(String(readOne<Opts>(filled, 'b')))
//! expect: 7 seven
//! expect: a,b
//! expect: seven
