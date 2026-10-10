// Classes passed where a parameter is typed by an interface they satisfy
// only structurally -- and through GETTERS: a database client's
// `resolveOptions(parent: OperationParent | undefined, options)` is called
// with `this` from `Collection`, `Db` and `Client`, each of which
// answers `readConcern`, `timeoutMS`, ... with an accessor over its own
// private state, and `s` with a field.
interface Namespace {
  db: string
}
interface OperationParent {
  s: { namespace: Namespace }
  readConcern?: string
  timeoutMS?: number
}

class Collection {
  s: { namespace: Namespace; level: string; timeout?: number }
  constructor(db: string, timeout?: number) {
    this.s = { namespace: { db }, level: 'local', ...(timeout === undefined ? {} : { timeout }) }
  }
  get readConcern(): string | undefined {
    return this.s.level
  }
  get timeoutMS(): number | undefined {
    return this.s.timeout
  }
  describe(): string {
    return resolveOptions(this, { tag: 'coll' })
  }
}

class Db {
  s: { namespace: Namespace }
  constructor(db: string) {
    this.s = { namespace: { db } }
  }
  get timeoutMS(): number | undefined {
    return 7
  }
  describe(): string {
    return resolveOptions(this)
  }
}

function resolveOptions(parent: OperationParent | undefined, options?: { tag?: string }): string {
  return `${parent?.s.namespace.db} ${parent?.readConcern} ${parent?.timeoutMS} ${options?.tag}`
}

console.log(new Collection('a', 3).describe())
console.log(new Collection('b').describe())
console.log(new Db('c').describe(), resolveOptions(undefined, {}))
//! expect: a local 3 coll
//! expect: b local undefined coll
//! expect: c undefined 7 undefined undefined undefined undefined undefined
