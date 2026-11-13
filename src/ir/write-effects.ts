import type { FunctionId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { borrowSafeOperationsOf, type PlainFieldRead } from './borrow-effects.js'
import { stringConstantsOf } from './dead-values.js'
import type { IrBody, IrNonTerminatorOperation } from './model.js'
import { arrayAllocationDrainsDynamicIterator } from './queries.js'

/**
 * Which property keys running an operation can store into, on any object.
 *
 * A read of `scene.fog` that a later statement uses names the same value at
 * that use only when nothing between the two can store `fog`: then the read
 * can name the field instead of retaining a copy of it (`targets/cpp`'s
 * stable field reads). Construction-only fields (`construction-only-fields.ts`)
 * answer that for the whole program at once; this answers it for one window
 * of one body, so a field the program does rewrite -- a material's map, a
 * scene's fog -- still holds one value across the statements that read it.
 *
 * Keys are matched by name, whatever the receiver: a store of `fog` anywhere
 * in a callee poisons every `fog` read across the call. A call is described
 * by the bodies it can enter (`CallOperation.closedCallee`), summarized to a
 * fixed point over the whole program; anything that can run code this
 * analysis does not see -- an unresolved call, an accessor, a coercion that
 * may call `valueOf`, a suspension -- can store every key.
 */
export interface WriteEffects {
  /** Whether running `operation` of `body` can store `key` on some object. */
  readonly mayStore: (body: IrBody, operation: IrNonTerminatorOperation, key: string) => boolean
  /** Whether reading `key` off a value carried as `receiver` loads a data field (`PlainFieldRead`). */
  readonly plainField: PlainFieldRead
}

type Summary = { readonly all: true } | { readonly all: false; readonly keys: Set<string> }

type Local =
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'calls'; readonly functionIds: readonly FunctionId[] }

const none: Local = { kind: 'none' }
const all: Local = { kind: 'all' }

const primitiveKinds: ReadonlySet<string> = new Set(['scalar', 'string', 'null', 'undefined', 'symbol', 'record-literal'])
const primitive = (value: Representation): boolean => {
  if (value.kind === 'optional') return primitive(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => primitive(arm.value))
  return primitiveKinds.has(value.kind)
}

/** Carriers whose property reads load native data: no getter of the program's can run. */
const nativeDataKinds: ReadonlySet<string> = new Set([
  'string',
  'typed-array',
  'array-buffer',
  'shared-array-buffer',
  'data-view',
  'array-object',
  'dense-buffer',
  'native-sequence',
  'native-handle'
])
const nativeData = (value: Representation): boolean =>
  value.kind === 'optional' ? nativeData(value.payload) : nativeDataKinds.has(value.kind)

/**
 * An argument a host function can only read as data: a host method handed one
 * can neither call it back nor coerce it through a method of the program's
 * (`join` on an array of class instances calls their `toString`).
 */
const inertArgument = (value: Representation): boolean => {
  if (value.kind === 'optional') return inertArgument(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => inertArgument(arm.value))
  if (primitive(value)) return true
  return (
    value.kind === 'typed-array' ||
    value.kind === 'array-buffer' ||
    value.kind === 'shared-array-buffer' ||
    value.kind === 'data-view' ||
    (value.kind === 'native-handle' && value.native !== null) ||
    ((value.kind === 'array-object' || value.kind === 'dense-buffer' || value.kind === 'native-sequence') &&
      'element' in value &&
      primitive(value.element))
  )
}

const localEffectsOf = (
  body: IrBody,
  plainFieldRead: PlainFieldRead,
  codeFreeRead: PlainFieldRead
): Map<IrNonTerminatorOperation, Local> => {
  const keys = stringConstantsOf(body)
  const producers = new Map<IrValueId, IrNonTerminatorOperation>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      const result = 'result' in operation ? operation.result : null
      if (result !== null && typeof result === 'object' && 'id' in result) producers.set(result.id, operation)
    }
  const safe = borrowSafeOperationsOf(body, new Set(), plainFieldRead)
  const unwrap = (value: Representation): Representation => (value.kind === 'optional' ? value.payload : value)
  const effects = new Map<IrNonTerminatorOperation, Local>()
  const classify = (operation: IrNonTerminatorOperation): Local => {
    switch (operation.kind) {
      case 'constant':
      case 'binding-read':
      case 'binding-write':
      case 'binding-renew':
      case 'parameter':
      case 'receiver':
      case 'phi':
      case 'global-this':
      case 'allocate-ordinary-object':
      case 'allocate-record':
      case 'allocate-callable':
      case 'test':
        return none
      case 'allocate-array-object':
        return arrayAllocationDrainsDynamicIterator(operation) ? all : none
      case 'compute':
        // A nullish check throws or passes; it reads no property and calls nothing.
        return safe.has(operation) || operation.form === 'require-object-coercible' ? none : all
      case 'convert':
        // An unwrap, a widening or a re-carry runs nothing; only a coercion of
        // an object into a primitive can call one of the program's methods.
        return primitive(operation.source.representation) || !primitive(operation.result.representation) ? none : all
      case 'get': {
        if (safe.has(operation)) return none
        if (operation.hostMethod !== undefined || nativeData(operation.receiver.representation)) return none
        const key = keys.get(operation.key.value)
        return key !== undefined && codeFreeRead(unwrap(operation.receiver.representation), key) ? none : all
      }
      case 'set': {
        if (safe.has(operation)) return none
        const key = keys.get(operation.key.value)
        const receiver = unwrap(operation.receiver.representation)
        if (receiver.kind === 'array-object' && operation.key.representation.kind === 'scalar') return none
        if (key === undefined) return all
        return plainFieldRead(receiver, key) || receiver.kind === 'native-handle' ? { kind: 'key', key } : all
      }
      case 'call': {
        if (safe.has(operation)) return none
        const closed = operation.closedCallee
        if (closed !== undefined) return { kind: 'calls', functionIds: closed.kind === 'exact' ? [closed.functionId] : closed.functionIds }
        const callee = producers.get(operation.callee.value)
        // The receiver counts as an argument: `sort()` and `join()` on an array
        // of class instances call each element's `toString`.
        const receiver = callee?.kind === 'get' ? unwrap(callee.receiver.representation) : null
        const host =
          callee?.kind === 'get' &&
          receiver !== null &&
          (callee.hostMethod !== undefined || nativeData(receiver)) &&
          (receiver.kind === 'native-handle' || inertArgument(receiver))
        return host && operation.arguments.every((argument) => inertArgument(argument.representation)) ? none : all
      }
      default:
        return all
    }
  }
  for (const block of body.blocks.values()) for (const operation of block.operations) effects.set(operation, classify(operation))
  return effects
}

/**
 * `codeFreeRead` answers whether reading `key` off a carrier runs none of the
 * program's code: a data field, or a method a class installs (no accessor).
 */
export const writeEffectsOf = (bodies: readonly IrBody[], plainFieldRead: PlainFieldRead, codeFreeRead: PlainFieldRead): WriteEffects => {
  const locals = new Map<IrBody, Map<IrNonTerminatorOperation, Local>>()
  const bodiesOf = new Map<string, IrBody[]>()
  for (const body of bodies) {
    locals.set(body, localEffectsOf(body, plainFieldRead, codeFreeRead))
    const owner = String(body.sourceOwner)
    const list = bodiesOf.get(owner) ?? []
    list.push(body)
    bodiesOf.set(owner, list)
  }
  // Owners' summaries grow from nothing: a recursive component stores only
  // what some member's own operations store, by induction on call depth.
  const summaries = new Map<string, Summary>()
  for (const owner of bodiesOf.keys()) summaries.set(owner, { all: false, keys: new Set() })
  const absorb = (into: Set<string>, owner: string): boolean => {
    const callee = summaries.get(owner)
    if (callee === undefined || callee.all) return false
    for (const key of callee.keys) into.add(key)
    return true
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [owner, ownerBodies] of bodiesOf) {
      const current = summaries.get(owner)
      if (current === undefined || current.all) continue
      const keys = new Set(current.keys)
      let everything = false
      for (const body of ownerBodies) {
        for (const local of locals.get(body)?.values() ?? []) {
          if (local.kind === 'all') everything = true
          else if (local.kind === 'key') keys.add(local.key)
          else if (local.kind === 'calls')
            for (const functionId of local.functionIds) if (!absorb(keys, String(functionId))) everything = true
          if (everything) break
        }
        if (everything) break
      }
      if (everything) {
        summaries.set(owner, { all: true })
        changed = true
      } else if (keys.size !== current.keys.size) {
        summaries.set(owner, { all: false, keys })
        changed = true
      }
    }
  }
  return {
    plainField: plainFieldRead,
    mayStore: (body, operation, key) => {
      const local = locals.get(body)?.get(operation)
      if (local === undefined || local.kind === 'all') return true
      if (local.kind === 'none') return false
      if (local.kind === 'key') return local.key === key
      return local.functionIds.some((functionId) => {
        const summary = summaries.get(String(functionId))
        return summary === undefined || summary.all || summary.keys.has(key)
      })
    }
  }
}

/** No window is clean: the answer for a context built without the census. */
export const everyStoreEffects: WriteEffects = { mayStore: () => true, plainField: () => false }
