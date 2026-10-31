// Zag's `compact<T extends Record<string, unknown> | undefined>(obj: T): T`
// (utils object.ts) is called with an `any` argument, so the checker
// instantiates it at `T = any`. That copy may receive any value at all: a
// constraint bounds the type arguments a caller writes, not the values an
// `any` argument carries. Neither the predicate's `unknown` parameter nor the
// call's own result may be narrowed to the constraint the checker reads at a
// `T`-typed reference; both must hold the string the program passed.
//! expect: typed toggle
//! expect: any toggle
//! expect: held string toggle
export {}

const isPlainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

function compact<T extends Record<string, unknown> | undefined>(obj: T): T {
  if (!isPlainObject(obj) || obj === undefined) return obj
  return obj
}

const user: { id?: string } = { id: 'toggle' }
console.log('typed ' + compact(user).id)
const raw: any = 'toggle'
console.log('any ' + String(compact(raw)))
const held = compact(raw)
console.log('held ' + typeof held + ' ' + String(held))
