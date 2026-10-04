import type { StructuralTypeId } from '../../identity/ids.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import {
  representationKey,
  type Ownership,
  type RecordField,
  type RecordIndexSidecar,
  type Representation
} from '../../representation/model.js'
import { fieldPresenceOf, staticOwnFieldsOf } from '../../representation/record-fields.js'
import { nativeEnumerationPlanOf } from '../native-enumeration.js'

/**
 * The pure `(kind, representation[, receiver][, deriver]) => string`
 * refinements `preflight/runtime-helper-key.ts` used to compute a
 * `protocol:*`/`allocation:regexp-object:*` carrier key from a SEMANTIC
 * operand it first had to resolve through the plan. `ir/certify/runtime-helper.ts`
 * needs the identical spellings for the LOWERED operand, which already
 * carries its representation directly (`IrOperand.representation`) -- so the
 * resolution half (operand -> representation, through the plan or the
 * deriver) stays in `runtime-helper-key.ts`, and only the refinement half
 * moves here, imported by both, so the two censuses cannot spell one carrier
 * two different ways.
 *
 * Every function here takes `kind` as an explicit argument rather than
 * deriving it from `representation.kind` internally, because the two are NOT
 * always the same fact: a semantic operand whose own result exists but was
 * never selected by the plan reports `kind === 'unselected'` while
 * `representation` is `undefined` -- a real, distinct outcome from an
 * operand that does not exist at all (`kind === 'absent'`), and both old
 * skip-paths return `kind` verbatim in that case. Collapsing the two into
 * one `representation?.kind ?? 'absent'` computation would silently turn
 * "unselected" into "absent" and change what the old preflight walk
 * certified. A lowered `IrOperand`'s representation is always resolved, so
 * the IR side simply passes `representation.kind` for both arguments.
 */

/**
 * `for`-`in`'s `get-iterator` step, refined the way a `native-record-ref`
 * receiver (host-bound vs. compiler-owned) and a `dictionary`/`optional`
 * receiver's own key domain must be to tell a claimed carrier from an
 * identically-`.kind`ed one this backend cannot walk. See
 * `preflight/runtime-helper-key.ts`'s own (much longer) doc for the full
 * reasoning; this is that function's body, unchanged, parameterized by the
 * representation directly instead of by a semantic operand.
 */
export const enumerateGetIteratorCarrierKeyOf = (kind: string, representation: Representation | undefined): string => {
  if (
    representation &&
    (representation.kind === 'optional' || representation.kind === 'tagged-union') &&
    nativeEnumerationPlanOf(representation)
  )
    return 'native-sum'
  if (kind === 'dictionary') return representation?.kind === 'dictionary' ? `dictionary(${representation.key})` : kind
  if (kind === 'optional') {
    const payload = representation?.kind === 'optional' ? representation.payload : null
    if (!payload) return kind
    return payload.kind === 'dictionary' ? `optional(dictionary(${payload.key}))` : `optional(${payload.kind})`
  }
  if (kind !== 'native-record-ref') return kind
  return representation?.kind === 'native-record-ref' && representation.native !== null ? 'native-record-ref(host-bound)' : kind
}

/**
 * Whether a "record"/"record-with-index" carrier declares its OWN
 * `[Symbol.iterator]` (or `[Symbol.asyncIterator]`) field -- see
 * `preflight/runtime-helper-key.ts`'s own doc for the full reasoning
 * (unchanged here; only moved).
 */
export const recordHasIteratorMethodField = (deriver: RepresentationDeriver, representation: Representation): boolean => {
  const fields =
    representation.kind === 'record-with-index'
      ? representation.fields
      : representation.kind === 'record' || representation.kind === 'native-record-ref'
        ? staticOwnFieldsOf(deriver, representation)
        : null
  if (fields === null) return false
  return fields.some((field) => {
    if (!field.key.startsWith('sym(')) return false
    if (field.value.kind !== 'function-value-dispatch') return false
    const abi = field.value.abi
    // A DECLARED receiver does not disqualify the member. ECMA-262 7.4.2
    // `GetIterator` performs `Call(method, obj)` -- the receiver is part of
    // the step, not an obstacle to it -- and `emitDynamicGetIterator` renders
    // exactly that through `iteratorMethodCallText`, which supplies the
    // receiver argument when and only when the ABI declares one. Refusing a
    // receiver-carrying `[Symbol.iterator]` here made the DECLARATION's
    // spelling decide whether the protocol was claimed at all: the identical
    // member reached this predicate with a receiver when it was written as
    // `type C = { [Symbol.iterator](): Cursor }` (an alias anchors the
    // implicit receiver, `structural-receiver.ts`) and without one otherwise,
    // so `typed-custom-iterator-close.ts` was refused by name for a shape the
    // emitter can print. Parameters still disqualify: `GetIterator` passes
    // none, so a member that requires one is not the protocol's method.
    if (abi.parameters.length !== 0) return false
    const nextResult = abi.result
    if (nextResult.kind === 'iterator' || nextResult.kind === 'async-generator') return true
    const resultFields =
      nextResult.kind === 'record'
        ? nextResult.fields
        : nextResult.kind === 'native-record-ref'
          ? staticOwnFieldsOf(deriver, nextResult)
          : null
    const resultAccessors =
      nextResult.kind === 'record'
        ? nextResult.accessors
        : nextResult.kind === 'native-record-ref'
          ? (() => {
              const resolved = deriver.layoutOf(nextResult.shapeId as StructuralTypeId)
              return resolved.kind === 'record' ? resolved.accessors : null
            })()
          : null
    if (resultFields === null && resultAccessors === null) return false
    const member = (key: string) => resultFields?.find((entry) => entry.key === key)
    if (member('value') !== undefined && member('done') !== undefined) return true
    return (
      member('next')?.value.kind === 'function-value-dispatch' ||
      resultAccessors?.some((accessor) => accessor.key === 'next' && accessor.getter !== null) === true
    )
  })
}

/**
 * Whether a `record` is a TUPLE's carrier whose elements a single native
 * cursor can walk -- see `preflight/runtime-helper-key.ts`'s own doc.
 */
export const isUniformTupleRecord = (representation: Representation): boolean => {
  if (representation.kind !== 'record' || representation.fields.length === 0) return false
  const first = representation.fields[0]
  if (!first) return false
  const elementKey = representationKey(first.value)
  return representation.fields.every(
    (field, position) => field.key === String(position) && field.required && representationKey(field.value) === elementKey
  )
}

/** Whether a sum's arms are all shared Arrays or Sets -- the only sums `emit-iterator.ts` walks natively. */
export const isSequenceSum = (representation: Representation): boolean =>
  representation.kind === 'tagged-union' &&
  representation.arms.length > 0 &&
  representation.arms.every(
    (arm) =>
      (arm.value.kind === 'array-object' || (arm.value.kind === 'keyed-collection' && arm.value.family === 'set')) &&
      arm.value.ownership === 'shared-refcount'
  )

/** The wrapped key an ABSENT iteration source reports, or `null` when `kind` is not `optional`. */
const optionalIterationSourceKeyOf = (kind: string, representation: Representation | undefined): string | null => {
  if (kind !== 'optional') return null
  if (representation?.kind !== 'optional') return kind
  return `optional(${representation.payload.kind})`
}

/**
 * The `iterator`/`async-iterator` protocol's `get-method`/`get-iterator`
 * carrier -- see `preflight/runtime-helper-key.ts`'s own doc for the full
 * reasoning behind the `record(no-iterator-method)`/`record(tuple-values)`
 * split.
 */
export const iteratorMethodCarrierKeyOf = (
  kind: string,
  representation: Representation | undefined,
  deriver: RepresentationDeriver
): string => {
  const wrapped = optionalIterationSourceKeyOf(kind, representation)
  if (wrapped !== null) return wrapped
  // A sum whose every arm is an Array or a Set (`string[] | HostAddress[]`,
  // `any[] | Set<any>`) walks whichever arm is live with that arm's own
  // storage cursor; any other sum keeps the bare, unclaimed `tagged-union` key.
  if (kind === 'tagged-union') return representation && isSequenceSum(representation) ? 'tagged-union(sequences)' : kind
  if (kind !== 'record' && kind !== 'native-record-ref') return kind
  if (!representation) return `${kind}(no-iterator-method)`
  if (recordHasIteratorMethodField(deriver, representation)) return kind
  if (kind === 'native-record-ref') return 'native-record-ref(no-iterator-method)'
  return isUniformTupleRecord(representation) ? 'record(tuple-values)' : 'record(no-iterator-method)'
}

/** Whether a `record`/`class-ref` is a shape `emitSpreadCopy` can copy without calling user code -- see `runtime-helper-key.ts`'s doc. */
const isCopyableSpreadRecord = (deriver: RepresentationDeriver, representation: Representation): boolean => {
  const fields = staticOwnFieldsOf(deriver, representation)
  if (fields === null) return false
  // A literal's accessors are own properties no static unroll can read; a
  // shared record reaches them through the runtime's creation-order walk
  // (`gea::copyOwnPropertiesInCreationOrder`, `NativeOwnAccessors`), which
  // reads each key through [[Get]]. A value-carried one has no such walk.
  if (representation.kind === 'record' && representation.accessors.length > 0 && representation.ownership !== 'shared-refcount')
    return false
  return fields.every((field) => !field.key.startsWith('sym(') && fieldPresenceOf(field) !== 'unprovable')
}

const isCopyableSpreadRecordInto = (
  deriver: RepresentationDeriver,
  representation: Representation,
  receiver: Representation | undefined
): boolean => {
  if (!isCopyableSpreadRecord(deriver, representation) || receiver?.kind !== 'dictionary') return false
  const fields = staticOwnFieldsOf(deriver, representation)
  return fields !== null && (receiver.key === 'string' || fields.length === 0)
}

/**
 * An indexed record copied into a string-keyed dictionary: its declared fields
 * unroll as a static record's do, and its string sidecar walks as a
 * dictionary's does -- so it is copyable exactly when it has no other sidecar.
 */
export const isCopyableIndexedRecordIntoDictionary = (
  deriver: RepresentationDeriver,
  representation: Representation,
  receiver: Representation | undefined
): boolean => {
  if (receiver?.kind !== 'dictionary' || receiver.key !== 'string') return false
  const view = indexedRecordViewOf(deriver, representation)
  return (
    view !== null &&
    view.ownership !== 'borrowed' &&
    view.indexes.every((index) => index.key === 'string') &&
    view.fields.every((field) => !field.key.startsWith('sym('))
  )
}

/** Whether every arm of a tagged-union is a shape `emitSpreadCopy` can copy into this receiver -- see `runtime-helper-key.ts`'s doc. */
const isCopyableSpreadUnion = (
  deriver: RepresentationDeriver,
  representation: Representation,
  receiver: Representation | undefined
): boolean =>
  representation.kind === 'tagged-union' &&
  representation.arms.every((arm) =>
    arm.value.kind === 'dictionary'
      ? receiver?.kind === 'dictionary' && arm.value.key === receiver.key && (arm.value.key === 'string' || arm.value.key === 'symbol')
      : isCopyableSpreadRecordInto(deriver, arm.value, receiver) || isCopyableIndexedRecordIntoDictionary(deriver, arm.value, receiver)
  )

/**
 * A generated record with an index sidecar, whichever way it is carried: a
 * `record-with-index` inline, or a `native-record-ref` naming a shape whose
 * layout is one (a named interface with an index signature).
 */
export interface IndexedRecordView {
  readonly fields: readonly RecordField[]
  readonly indexes: readonly RecordIndexSidecar[]
  readonly ownership: Ownership
}

export const indexedRecordViewOf = (deriver: RepresentationDeriver, representation: Representation): IndexedRecordView | null => {
  if (representation.kind === 'record-with-index') return representation
  if (representation.kind !== 'native-record-ref' || representation.native !== null) return null
  const layout = deriver.layoutOf(representation.shapeId as StructuralTypeId)
  return layout.kind === 'record-with-index'
    ? { fields: layout.fields, indexes: layout.indexes, ownership: representation.ownership }
    : null
}

/**
 * The string-keyed index sidecar of an indexed-record spread RECEIVER -- an
 * object literal whose own type carries an index signature -- or `null` when
 * it has none to take the keys its declared fields do not name. A symbol
 * index is not asked for: the sources below copy string keys only.
 */
export const spreadIndexedRecordReceiverOf = (
  deriver: RepresentationDeriver,
  receiver: Representation | undefined
): { readonly view: IndexedRecordView; readonly index: RecordIndexSidecar } | null => {
  const view = receiver ? indexedRecordViewOf(deriver, receiver) : null
  if (view === null || view.ownership === 'borrowed') return null
  const index = view.indexes.find((candidate) => candidate.key === 'string')
  return index ? { view, index } : null
}

/**
 * A spread RECEIVER that is a plain field record -- an object literal whose
 * own type states its keys and no index signature -- or `null` for any other.
 *
 * The literal's fields are the only keys it can hold: a key the source has and
 * the literal's type does not name is not copied, exactly as the static
 * field-by-field copy scopes itself to the target's own fields
 * (`producers/allocations.ts`'s `spreadCopyOf`). This receiver exists for the
 * source whose presence the static copy cannot carry -- one with an OPTIONAL
 * member, or `undefined` among its arms -- where `CopyDataProperties` copies a
 * key only when the source actually HAS it, so each copied key's presence bit
 * travels with its value.
 */
export const spreadFieldRecordReceiverOf = (
  deriver: RepresentationDeriver,
  receiver: Representation | undefined
): { readonly fields: readonly RecordField[]; readonly ownership: Ownership } | null => {
  if (receiver === undefined) return null
  // A `class-ref` receiver is an object literal laid out as a data-only class
  // (`lower-allocation.ts`) -- the only way a spread ever writes into one --
  // whose fields are the class's own static fields.
  if (receiver.kind !== 'record' && receiver.kind !== 'class-ref' && (receiver.kind !== 'native-record-ref' || receiver.native !== null))
    return null
  if (receiver.ownership === 'borrowed' || (receiver.kind === 'record' && receiver.accessors.length > 0)) return null
  const fields = staticOwnFieldsOf(deriver, receiver)
  return fields === null ? null : { fields, ownership: receiver.ownership }
}

/**
 * Whether `emitSpreadCopy` copies this source into a field-record receiver: a
 * static-field record, a string-keyed dictionary -- each run-time key the
 * receiver's type names lands in that field through its checked conversion,
 * the rest is outside the literal's type -- or an optional or tagged union of
 * those. mongodb's `{ ...currentOp, limit: 1 }` spreads a `Document`.
 */
const isCopyableIntoFieldRecord = (deriver: RepresentationDeriver, representation: Representation): boolean => {
  if (representation.kind === 'optional') return isCopyableIntoFieldRecord(deriver, representation.payload)
  if (representation.kind === 'tagged-union')
    return representation.arms.length > 0 && representation.arms.every((arm) => isCopyableIntoFieldRecord(deriver, arm.value))
  // A number, boolean, bigint, `null` or `undefined` has no own enumerable
  // properties, so spreading it copies nothing: mongodb's
  // `...(cond && { timeoutMode })` spreads `false` or a record.
  if (representation.kind === 'scalar' || representation.kind === 'null' || representation.kind === 'undefined') return true
  if (representation.kind === 'dictionary') return representation.key === 'string'
  // An indexed record's sidecar entries are routed by key text exactly as a
  // dictionary's are, so only a string-keyed sidecar is admitted.
  if (indexedRecordViewOf(deriver, representation) !== null) return isStringKeyedIndexedRecord(deriver, representation)
  return isCopyableSpreadRecord(deriver, representation)
}

const isStringKeyedIndexedRecord = (deriver: RepresentationDeriver, representation: Representation): boolean => {
  const view = indexedRecordViewOf(deriver, representation)
  return (
    view !== null &&
    view.ownership !== 'borrowed' &&
    view.indexes.every((index) => index.key === 'string') &&
    view.fields.every((field) => !field.key.startsWith('sym('))
  )
}

/**
 * Whether `emitSpreadCopy` copies a genuinely dynamic source into this
 * field-record receiver: mongodb's option table spreads a `values: unknown[]`
 * element, narrowed by a guard, into `{ ...options.readConcern, ...value }`.
 * The source's own enumerable string keys are walked at run time and each one
 * the literal's type names lands in that field through its checked
 * conversion -- the dictionary source's rule. A receiver with a symbol-named
 * field is refused: the walk compares key TEXT, and a symbol key the source
 * carries would otherwise be dropped instead of reaching its field.
 */
export const isDynamicCopyableIntoFieldRecord = (deriver: RepresentationDeriver, receiver: Representation | undefined): boolean => {
  const target = spreadFieldRecordReceiverOf(deriver, receiver)
  return target !== null && target.fields.every((field) => !field.key.startsWith('sym('))
}

/**
 * Whether `emitSpreadCopy` copies this source into an indexed-record
 * receiver: every key lands in a declared field when the receiver names it
 * and in the string sidecar otherwise, so the source must yield string keys
 * only -- a string-keyed dictionary, a static-field record, an indexed record
 * whose only sidecar is string-keyed, or an optional or tagged union of those.
 */
const isCopyableIntoIndexedRecord = (deriver: RepresentationDeriver, representation: Representation): boolean => {
  if (representation.kind === 'optional') return isCopyableIntoIndexedRecord(deriver, representation.payload)
  if (representation.kind === 'tagged-union') {
    return representation.arms.length > 0 && representation.arms.every((arm) => isCopyableIntoIndexedRecord(deriver, arm.value))
  }
  if (representation.kind === 'dictionary') return representation.key === 'string'
  if (indexedRecordViewOf(deriver, representation) !== null) return isStringKeyedIndexedRecord(deriver, representation)
  return isCopyableSpreadRecord(deriver, representation)
}

/** The source carrier kinds `spreadSourceCarrierKeyOf` refines beyond their bare `.kind` -- see `runtime-helper-key.ts`'s doc. */
const refinableSpreadSourceKinds: ReadonlySet<string> = new Set(['tagged-union', 'optional', 'record', 'class-ref', 'native-record-ref'])

/**
 * `CopyDataProperties`'s source carrier, refined the way a `dictionary`'s key
 * domain, a `tagged-union`'s per-arm copyability, and an `optional`'s present
 * payload have to be -- see `preflight/runtime-helper-key.ts`'s own (longer)
 * doc for the full reasoning; this is that function's body, parameterized by
 * the two representations directly instead of by a semantic operand pair.
 */
export const spreadSourceCarrierKeyOf = (
  kind: string,
  representation: Representation | undefined,
  receiver: Representation | undefined,
  deriver: RepresentationDeriver
): string => {
  if (!representation) return kind
  if (receiver !== undefined && indexedRecordViewOf(deriver, receiver) !== null) {
    return spreadIndexedRecordReceiverOf(deriver, receiver) !== null && isCopyableIntoIndexedRecord(deriver, representation)
      ? 'indexed-record<-copyable'
      : `indexed-record<-${kind}`
  }
  const dictionaryKind = (candidate: Extract<Representation, { kind: 'dictionary' }>): string =>
    receiver?.kind === 'dictionary'
      ? `dictionary(${candidate.key}->${receiver.key})`
      : `dictionary(${candidate.key}->${receiver?.kind ?? 'absent'})`
  if (representation.kind === 'dynamic') {
    if (isDynamicCopyableIntoFieldRecord(deriver, receiver)) return 'field-record<-dynamic'
    return receiver?.kind === 'dictionary' ? `dynamic->dictionary(${receiver.key})` : `dynamic->${receiver?.kind ?? 'absent'}`
  }
  // A dynamic receiver walks a typed source through its box (`emit-allocation.ts`).
  if (receiver?.kind === 'dynamic') return 'boxed->dynamic'
  if (spreadFieldRecordReceiverOf(deriver, receiver) !== null)
    return isCopyableIntoFieldRecord(deriver, representation) ? 'field-record<-copyable' : `field-record<-${kind}`
  if (representation.kind === 'dictionary') return dictionaryKind(representation)
  if (!refinableSpreadSourceKinds.has(kind)) return kind
  const copyableKind = (candidate: Representation): string | null =>
    isCopyableSpreadUnion(deriver, candidate, receiver)
      ? 'tagged-union(record-or-dictionary)'
      : candidate.kind === 'dictionary'
        ? dictionaryKind(candidate)
        : isCopyableSpreadRecordInto(deriver, candidate, receiver)
          ? `${candidate.kind}(copyable)`
          : isCopyableIndexedRecordIntoDictionary(deriver, candidate, receiver)
            ? 'indexed-record(copyable)'
            : null
  if (representation.kind === 'optional') return `optional(${copyableKind(representation.payload) ?? representation.payload.kind})`
  return copyableKind(representation) ?? kind
}

export type RegexpFlagSupportKey = 'supported-flags' | 'unicode-flags' | 'unicode-ignore-case-flags' | 'unicode-sets-flags'

/**
 * `u` selects the runtime's scalar-value matcher, while `v` stays unbuilt --
 * see `preflight/runtime-helper-key.ts`'s own doc. Unlike that file's
 * version, `flags` here is always a concrete string: by the time an
 * `AllocateRegExpOperation` exists, lowering has already required its own
 * `pattern-flags` operand to be a constant string (`lower-allocation.ts`'s
 * `textOf`), so there is no `unselected-flags` state left to report.
 */
export const regexpFlagSupportKeyOf = (flags: string): RegexpFlagSupportKey => {
  if (flags.includes('v')) return 'unicode-sets-flags'
  if (flags.includes('u') && flags.includes('i')) return 'unicode-ignore-case-flags'
  return flags.includes('u') ? 'unicode-flags' : 'supported-flags'
}
