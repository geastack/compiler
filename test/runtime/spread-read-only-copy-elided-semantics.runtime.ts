// A binary-document deserializer's `deserializeObject` opens with `options = { ...options }` and then
// only reads `options` by constant key before its first call. The fresh copy
// is unobservable there, so the compiler reads the source in its place
// (`ir/spread-copy-elision.ts`); every answer below must be the one the copy
// would have given: a present key, an absent key, a key the source holds as
// `undefined`, and a read that follows the spread on a branch.
interface Validation {
  utf8: boolean
}

interface Options {
  raw?: boolean
  limit?: number
  label?: string
  promote?: boolean | undefined
  validation?: Validation
}

function readOnly(options: Options): string {
  options = { ...options }
  const raw = options['raw'] == null ? false : options['raw']
  const limit = options.limit ?? 10
  const label = options.label ?? '-'
  const promote = options.promote ?? true
  const validation = options.validation == null ? { utf8: true } : options.validation
  if (limit < 0) throw new Error('negative limit')
  return `${raw}:${limit}:${label}:${promote}:${validation.utf8}`
}

function defaulted(options: Options = {}): string {
  options = { ...options }
  const limit = options.limit ?? 4
  const label = options.label ?? '-'
  if (limit < 0) throw new Error('negative limit')
  return `${limit}:${label}`
}

function maybeAbsent(options: Options | undefined): string {
  options = { ...options }
  const limit = options.limit ?? 6
  const label = options.label ?? '-'
  if (limit < 0) throw new Error('negative limit')
  return `${limit}:${label}`
}

function afterCalls(options: Options, values: number[]): string {
  options = { ...options }
  const limit = options.limit ?? 5
  let total = 0
  for (const value of values) total += value * limit
  return `${limit}:${total}`
}

const empty: Options = {}
const full: Options = { raw: true, limit: 3, label: 'x', promote: false, validation: { utf8: false } }
const explicitUndefined: Options = { limit: undefined, promote: undefined }

console.log(readOnly(empty))
console.log(readOnly(full))
console.log(readOnly(explicitUndefined))
console.log(defaulted())
console.log(defaulted(full))
console.log(maybeAbsent(undefined))
console.log(maybeAbsent(full))
console.log(afterCalls(empty, [1, 2, 3]))
console.log(afterCalls(full, [1, 2, 3]))
// The caller's object is read, never written: it still holds what it held.
console.log(`${full.limit}:${full.label}:${empty.limit}`)
//! expect: false:10:-:true:true
//! expect: true:3:x:false:false
//! expect: false:10:-:true:true
//! expect: 4:-
//! expect: 3:x
//! expect: 6:-
//! expect: 3:x
//! expect: 5:30
//! expect: 3:18
//! expect: 3:x:undefined
