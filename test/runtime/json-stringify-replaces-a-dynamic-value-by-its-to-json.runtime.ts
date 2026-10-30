// ECMA-262 25.5.2.2 step 2: SerializeJSONProperty replaces an object whose
// `toJSON` is callable by `toJSON(key)`, called on that object, before it
// writes the value or omits it. A Date answers its ISO string this way
// (21.4.4.37). The dynamic writer -- an `any` value, or a record the typed
// writer cannot spell and so writes from its box -- never asked, and wrote
// both as `{}`.
export {}

// A record with a Date field is written from its box.
interface Stamped {
  id: string
  when: Date
}
const stamp = (): Stamped => ({ id: 'w', when: new Date(0) })
//! expect: {"id":"w","when":"1970-01-01T00:00:00.000Z"}
console.log(JSON.stringify(stamp()))

// So is a record whose field holds an object with its own toJSON.
interface Inner {
  toJSON(): string
}
interface Wrapped {
  id: string
  inner: Inner
}
const wrapped: Wrapped = { id: 'v', inner: { toJSON: () => 'T' } }
//! expect: {"id":"v","inner":"T"}
console.log(JSON.stringify(wrapped))

// The key is the property name, the index as a string, or "" at the top.
// A toJSON answering undefined omits the property.
const loose: any = {
  a: { toJSON: (key: string) => `key=${key}` },
  list: [new Date(0), { toJSON: (key: string) => `at=${key}` }],
  gone: { toJSON: () => undefined },
  n: 1
}
//! expect: {"a":"key=a","list":["1970-01-01T00:00:00.000Z","at=1"],"n":1}
console.log(JSON.stringify(loose))
//! expect: top="key="
console.log(`top=${JSON.stringify(loose.a)}`)

// `this` is the object; the result is not asked for its own toJSON.
const self: any = {
  v: 7,
  toJSON() {
    return this.v
  }
}
const once: any = { toJSON: () => ({ toJSON: () => 'again', y: 1 }) }
//! expect: self=7 once={"y":1}
console.log(`self=${JSON.stringify(self)} once=${JSON.stringify(once)}`)

// A top-level toJSON answering undefined makes the whole call undefined.
const absent: any = { toJSON: () => undefined }
//! expect: absent=true
console.log(`absent=${JSON.stringify(absent) === undefined}`)

// A replacer sees what toJSON answered.
const dated: any = { d: new Date(0) }
//! expect: {"d":"1970-01-01T00:00:00.000Z!"}
console.log(JSON.stringify(dated, (key: string, value: any) => (key === 'd' ? `${value}!` : value)))

// A typed record's own `any` field and an accessor are written by the record's
// generated overload, which asks the same way under the field's key and omits
// what has no JSON text.
interface Loose {
  id: string
  d: any
  gone: any
}
const typed: Loose = { id: 'r', d: { toJSON: (key: string) => `d@${key}` }, gone: undefined }
const getter = {
  id: 'o',
  get when(): any {
    return new Date(0)
  }
}
//! expect: {"id":"r","d":"d@d"} {"id":"o","when":"1970-01-01T00:00:00.000Z"}
console.log(JSON.stringify(typed), JSON.stringify(getter))

// A class instance in a field of a record written from its box keeps its
// toJSON method for that walk.
class Tag {
  toJSON() {
    return 'tag'
  }
}
const tagged = { id: 't', tag: new Tag() }
//! expect: {"id":"t","tag":"tag"}
console.log(JSON.stringify(tagged))
