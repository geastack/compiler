import type { SemanticOperand } from './operands.js'
import type { SemanticOperation } from './operations.js'

/**
 * One shared copy of every equal small fact a sealed graph holds.
 *
 * Producers build each operation's effect and completion summaries, its
 * operands' evaluation modes, its call target proof and selected signature as
 * fresh objects, so a 48K-line app sealed 300k operations carrying a few dozen
 * distinct effect summaries and a few thousand distinct signatures -- about
 * 30 MB of identical objects held from normalization to certification. These
 * facts are read only by value: nothing compares them by identity, keys a
 * collection on them, or writes them once sealed, so one copy per distinct
 * value answers every reader the same way.
 *
 * An operand's `source` is deliberately absent: a native own-assignment
 * receipt is checked against its argument's source by identity
 * (`ir/native-own-assignment.ts`), so two equal sources are not the same fact.
 */

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * The engine's own interned copy of a string.
 *
 * Every identity in the graph is looked up in a `Map` sooner or later, and V8
 * internalizes a string the first time it is used as a `Map` key: the string
 * table gets the characters and the original is left behind as a 24-byte
 * forwarding object that every holder keeps pointing at. A 48K-line app's
 * graph carried 830k of them, 19 MB, plus the unflattened concatenation trees
 * some identities were still built as. A property key is always interned, so
 * reading one back is how a script reaches the table's copy. Same characters,
 * so no reader can tell the difference.
 */
export const internedText = <T extends string>(text: T): T => (Object.keys({ [text]: 0 })[0] ?? text) as T

/** String-valued identity fields of an operation, interned in place. */
const operationIdentities = ['id', 'declaration', 'classDeclaration', 'classConstructorBodyOf', 'callable'] as const

/** Every string inside a fact that is about to be shared, interned in place; frozen parts are left as they are. */
const internStrings = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  const fields = value as Record<string, unknown>
  for (const name of Object.keys(fields)) {
    const field = fields[name]
    if (typeof field === 'string') fields[name] = internedText(field)
    else internStrings(field)
  }
}

/** The fields of an operation whose values are interned. */
const operationFacts = [
  'effects',
  'completion',
  'descriptor',
  'resultDivergence',
  'selectedSignature',
  'target',
  'conversionRoles',
  'caller'
] as const

/**
 * A key equal for two values exactly when they are interchangeable for a
 * reader: same own keys in the same order, same primitives (`-0` kept apart
 * from `0`, `undefined` from absent), same nesting. `null` for anything that
 * is not a plain record, array or primitive -- that value is left alone.
 */
const keyOf = (value: unknown): string | null => {
  if (value === null) return 'n'
  switch (typeof value) {
    case 'string':
      return `s${value.length}:${value}`
    case 'number':
      return Object.is(value, -0) ? 'd-0' : `d${value}`
    case 'boolean':
      return value ? 't' : 'f'
    case 'undefined':
      return 'u'
    case 'object':
      break
    default:
      return null
  }
  if (Array.isArray(value)) {
    let key = '['
    for (const item of value as unknown[]) {
      const itemKey = keyOf(item)
      if (itemKey === null) return null
      key += `${itemKey},`
    }
    return `${key}]`
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return null
  let key = '{'
  for (const name of Object.keys(value)) {
    const fieldKey = keyOf((value as Record<string, unknown>)[name])
    if (fieldKey === null) return null
    key += `${name.length}:${name}=${fieldKey},`
  }
  return `${key}}`
}

/**
 * A function interning one operation's facts in place. Meant for one sealing:
 * its pools go when the caller drops it.
 */
export const internSealedFacts = (): ((operation: SemanticOperation) => SemanticOperation) => {
  // Keyed by content alone: remembering every object already seen would hold
  // an entry per operand while the graph is being sealed, at the frontend's peak.
  const pool = new Map<string, unknown>()
  const canonical = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value
    const key = keyOf(value)
    if (key === null) return value
    const pooled = pool.get(key)
    if (pooled !== undefined) return pooled as T
    pool.set(key, value)
    internStrings(value)
    return value
  }
  const internOperand = (operand: SemanticOperand): void => {
    // The source object itself keeps its identity (see above); only the
    // identity text it carries is swapped for the interned copy.
    const { source } = operand
    if (source.kind === 'result' && !Object.isFrozen(source)) (source as Writable<typeof source>).result = internedText(source.result)
    if (Object.isFrozen(operand)) return
    const evaluation = canonical(operand.evaluation)
    if (evaluation !== operand.evaluation) (operand as Writable<SemanticOperand>).evaluation = evaluation
  }
  return (operation) => {
    if (!Object.isFrozen(operation)) {
      const fields = operation as unknown as Record<string, unknown>
      for (const field of operationIdentities) {
        const value = fields[field]
        if (typeof value === 'string') fields[field] = internedText(value)
      }
      for (const field of operationFacts) {
        if (!(field in fields)) continue
        const value = fields[field]
        const shared = canonical(value)
        if (shared !== value) fields[field] = shared
      }
      // A list a producer grew by pushing keeps the capacity its first push
      // reserved -- seventeen slots for a call's two or three arguments. A
      // copy is exactly as long as its contents.
      if (operation.operands.length > 0) fields['operands'] = operation.operands.slice()
    }
    for (const result of operation.results) if (!Object.isFrozen(result)) (result as Writable<typeof result>).id = internedText(result.id)
    for (const operand of operation.operands) internOperand(operand)
    return operation
  }
}
