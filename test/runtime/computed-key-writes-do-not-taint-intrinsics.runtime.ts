// Writes with runtime-computed keys onto objects the program itself allocated
// must not taint the built-in surface. The global host mutation census answers
// "may this receiver be a built-in object?" for every computed-key write; when
// it cannot rule that out, every intrinsic is distrusted and recognitions such
// as `Object.prototype.toString.call(x)` or the %TypedArray%.prototype
// @@toStringTag getter are refused. These are the shapes a serializer or
// document builder writes (a binary-document serializer, a database client): a null-prototype record
// filled from a Map, a `dest[name] = v` helper whose every caller passes a
// fresh literal, a record rebuilt from another record's entries.

interface Doc {
  [key: string]: any
}

function fromMap(value: Map<string, number>): Record<string, unknown> {
  const obj: Record<string, unknown> = Object.create(null)
  for (const [k, v] of value) {
    obj[k] = v
  }
  return obj
}

function assignValue(dest: Doc, name: string | number, value: unknown): void {
  dest[name] = value
}

function copyEntries(source: Doc): Doc {
  const log: Doc = {}
  for (const [key, value] of Object.entries(source)) {
    if (value != null) log[key] = value
  }
  return log
}

class CommandEvent {
  commandObj?: Doc
  constructor(commandName: string) {
    this.commandObj = {}
    this.commandObj[commandName] = true
  }
}

const source = new Map<string, number>()
source.set('a', 1)
source.set('b', 2)
const mapped = fromMap(source)
console.log(Object.keys(mapped).join(','), mapped['a'], mapped['b'])
//! expect: a,b 1 2

const doc: Doc = {}
assignValue(doc, 'x', 1)
assignValue(doc, 2, 'two')
console.log(doc['x'], doc['2'])
//! expect: 1 two

const copied = copyEntries({ p: 1, q: null, r: 'r' })
console.log(Object.keys(copied).join(','))
//! expect: p,r

const started = new CommandEvent('saslStart')
console.log(started.commandObj !== undefined && started.commandObj['saslStart'] === true)
//! expect: true

console.log(Object.prototype.toString.call(new Date(0)))
//! expect: [object Date]

const tagGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
console.log(tagGetter.call(new Uint8Array(1)))
//! expect: Uint8Array

export {}
