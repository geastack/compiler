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
 * An operand whose source is not another operation's result is shared whole:
 * a key, a tag name, a `null` argument or an absent value is the same operand
 * across thousands of operations -- 124k of a 48K-line app's 388k operands,
 * 20k distinct. One citing a result names it in its own identity, so it is
 * almost never repeated: 268k such sources, 242k distinct, so a pool entry per
 * one would cost more at the frontend's peak than it shares. Nothing
 * compares operands by identity, with one exception: a native own-assignment
 * receipt is checked against its argument's source object
 * (`ir/native-own-assignment.ts`), so an operation carrying one keeps its
 * operands as they are.
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
 * Two values are interchangeable for a reader when they have the same own
 * keys in the same order, the same primitives (`-0` kept apart from `0`,
 * `undefined` from absent) and the same nesting. Only plain records, arrays
 * and primitives are compared; `hashOf` is `null` for anything else, and that
 * value is left alone.
 *
 * The pool is keyed by a hash, with the values themselves telling a collision
 * apart, rather than by a spelled-out key: a key per distinct fact was held to
 * the end of production, the frontend's peak -- 54k of them on a 48K-line app,
 * 9 MB of text.
 */
const mix = (hash: number, code: number): number => Math.imul(hash ^ code, 16777619)

const mixText = (hash: number, text: string): number => {
  let mixed = mix(hash, text.length)
  for (let at = 0; at < text.length; at++) mixed = mix(mixed, text.charCodeAt(at))
  return mixed
}

const hashInto = (hash: number, value: unknown): number | null => {
  if (value === null) return mix(hash, 1)
  switch (typeof value) {
    case 'string':
      return mixText(mix(hash, 2), value)
    case 'number':
      return mixText(mix(hash, 3), Object.is(value, -0) ? '-0' : String(value))
    case 'boolean':
      return mix(hash, value ? 4 : 5)
    case 'undefined':
      return mix(hash, 6)
    case 'object':
      break
    default:
      return null
  }
  if (Array.isArray(value)) {
    let mixed: number | null = mix(hash, 7)
    for (const item of value as unknown[]) if ((mixed = hashInto(mixed, item)) === null) return null
    return mix(mixed, value.length)
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return null
  let mixed: number | null = mix(hash, 8)
  for (const name of Object.keys(value)) {
    mixed = hashInto(mixText(mixed, name), (value as Record<string, unknown>)[name])
    if (mixed === null) return null
  }
  return mix(mixed, 9)
}

const hashOf = (value: unknown): number | null => hashInto(0x811c9dc5, value)

/** Whether two values `hashOf` accepts are interchangeable for a reader. */
const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return Object.is(left, right)
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return Object.is(left, right)
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let at = 0; at < left.length; at++) if (!sameValue(left[at], right[at])) return false
    return true
  }
  if (Array.isArray(right)) return false
  const names = Object.keys(left)
  const others = Object.keys(right)
  if (names.length !== others.length) return false
  for (let at = 0; at < names.length; at++) {
    const name = names[at]!
    if (name !== others[at] || !sameValue((left as Record<string, unknown>)[name], (right as Record<string, unknown>)[name])) return false
  }
  return true
}

/** The one empty list a sealed operation's operands or results can be; frozen, as nothing may grow it. */
const noneSealed: readonly never[] = Object.freeze([])

/**
 * A function interning one operation's facts in place. Meant for one sealing:
 * its pools go when the caller drops it.
 */
export const internSealedFacts = (): ((operation: SemanticOperation) => SemanticOperation) => {
  // Keyed by content alone: remembering every object already seen would hold
  // an entry per operand while the graph is being sealed, at the frontend's peak.
  const pool = new Map<number, unknown>()
  // Hashes that collided: every value pooled under one, in pooling order.
  const collided = new Map<number, unknown[]>()
  const canonical = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value
    const hash = hashOf(value)
    if (hash === null) return value
    const pooled = pool.get(hash)
    if (pooled === undefined) pool.set(hash, value)
    else if (sameValue(pooled, value)) return pooled as T
    else {
      const others = collided.get(hash)
      const other = others?.find((candidate) => sameValue(candidate, value))
      if (other !== undefined) return other as T
      if (others) others.push(value)
      else collided.set(hash, [value])
    }
    internStrings(value)
    return value
  }
  // An operand's source is shared first, so equal operands then compare
  // their sources by identity.
  const sharedOperand = (operand: SemanticOperand): SemanticOperand => {
    if (!Object.isFrozen(operand)) {
      const source = canonical(operand.source)
      if (source !== operand.source) (operand as Writable<SemanticOperand>).source = source
    }
    return canonical(operand)
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
      // copy is exactly as long as its contents, and every empty list is one.
      const sealed = operation.operands.length > 0 ? operation.operands.slice() : noneSealed
      fields['operands'] = sealed
      if (operation.results.length === 0) fields['results'] = noneSealed
      for (const result of operation.results) if (!Object.isFrozen(result)) (result as Writable<typeof result>).id = internedText(result.id)
      const shareable = !('nativeOwnAssignment' in fields)
      for (let at = 0; at < sealed.length; at++) {
        const operand = sealed[at]!
        internOperand(operand)
        if (shareable && operand.source.kind !== 'result') (sealed as SemanticOperand[])[at] = sharedOperand(operand)
      }
      return operation
    }
    for (const result of operation.results) if (!Object.isFrozen(result)) (result as Writable<typeof result>).id = internedText(result.id)
    for (const operand of operation.operands) internOperand(operand)
    return operation
  }
}
