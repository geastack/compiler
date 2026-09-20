import type { RecordField, RecordIndexSidecar, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'

/**
 * One record viewed as another whose declared shape it satisfies -- the
 * decision, without any spelling.
 *
 * `type A = Named & { age: number }` and `({ ...base, ...extra })` describe
 * one shape and intern as two, so they derive two record carriers under two
 * shape ids; a class instance handed to a parameter typed by an interface it
 * implements is the same pair one level up. The C++ backend spells each as a
 * struct, and a value of one is not a value of the other, so the view REBUILDS
 * the target from the source's members: field by field, a class method bound
 * into the callable member the interface record stores, an optional peeled on
 * both sides, a sum entered at the one arm the source can become.
 *
 * This used to be decided where it was spelled (`targets/cpp/emit-callable.ts`'s
 * `structuralRecordViewText`), which left the conversion census unable to
 * answer the pair: lowering recorded drift for every initializer that viewed
 * a record, and the printer converted on its own path. The plan below is
 * what the registry's `staticRecipe` answers (`targets/cpp/conversions.ts`)
 * and what the printer renders from, so the two cannot disagree about which
 * pairs are views.
 *
 * `convertible(from, to)` is the registry's own answer for a field or arm
 * pair that is NOT a view -- a widening, a narrowing, an identity -- and is
 * the one thing this module does not decide itself: it belongs to the chain
 * the backend installs, and the plan only asks it.
 */

export type OwnedRecordPlan =
  | { readonly kind: 'identity'; readonly target: Representation }
  | { readonly kind: 'arm'; readonly target: Representation; readonly index: number; readonly payload: OwnedRecordPlan }
  | {
      readonly kind: 'record'
      readonly source: Extract<Representation, { kind: 'record' }>
      readonly target: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
      readonly fields: readonly { readonly key: string; readonly value: OwnedRecordPlan }[]
    }

/**
 * An OWNED record (a value, not a handle) materialized as a refcounted or
 * owned record of another shape, or as the one arm of a sum that shape fits:
 * every field required on both sides and itself materializable.
 */
export const ownedRecordMaterializationPlan = (
  source: Representation,
  target: Representation,
  layouts: RecordLayoutPolicy
): OwnedRecordPlan | null => {
  if (representationKey(source) === representationKey(target)) return { kind: 'identity', target }
  if (
    source.kind === 'record' &&
    target.kind === 'native-record-ref' &&
    target.native === null &&
    source.shapeId === target.shapeId &&
    source.ownership === target.ownership
  )
    return { kind: 'identity', target }
  if (source.kind !== 'record') return null
  if (target.kind === 'tagged-union') {
    const arms = target.arms.flatMap((arm, index) => {
      const payload = ownedRecordMaterializationPlan(source, arm.value, layouts)
      return payload === null ? [] : [{ kind: 'arm' as const, target, index, payload }]
    })
    return arms.length === 1 ? (arms[0] ?? null) : null
  }
  if (source.ownership !== 'owned' || source.accessors.length !== 0) return null
  if (target.kind !== 'record' && target.kind !== 'native-record-ref') return null
  if (target.ownership === 'borrowed') return null
  if (target.kind === 'native-record-ref' && target.native !== null) return null
  if (target.kind === 'record' && target.accessors.length !== 0) return null
  const fields = target.kind === 'record' ? target.fields : (layouts.plainFieldsForShape?.(target.shapeId) ?? null)
  if (fields === null || fields.length !== source.fields.length) return null
  const planned: { key: string; value: OwnedRecordPlan }[] = []
  for (const field of fields) {
    const held = source.fields.find((candidate) => candidate.key === field.key)
    if (!held || !held.required || !field.required) return null
    const value = ownedRecordMaterializationPlan(held.value, field.value, layouts)
    if (value === null) return null
    planned.push({ key: field.key, value })
  }
  return { kind: 'record', source, target, fields: planned }
}

export type RecordViewSource = Extract<Representation, { kind: 'record' | 'record-with-index' | 'native-record-ref' | 'class-ref' }>
export type RecordViewTarget = Extract<Representation, { kind: 'record' | 'native-record-ref' }>
type TaggedUnion = Extract<Representation, { kind: 'tagged-union' }>

/** Where one target field's value comes from. */
export type RecordFieldRead =
  /** A class method the target stores as a callable member: bound to the instance being viewed. */
  | { readonly kind: 'bound-method' }
  /**
   * A class ACCESSOR the target stores as a plain field: read by calling the
   * getter. `value` is the carrier the getter publishes, which the field is
   * built from.
   */
  | { readonly kind: 'class-accessor'; readonly value: Representation }
  /** An optional field the source does not carry: default-constructed, presence false. */
  | { readonly kind: 'absent' }
  /** The source's own field, converted by the registry's pair answer. */
  | { readonly kind: 'held'; readonly held: RecordField }

export interface RecordFieldPlan {
  readonly field: RecordField
  readonly read: RecordFieldRead
}

/** One source arm's home in the target sum: the same carrier, a pair the registry converts, or a nested view. */
export interface RecastArmPlan {
  readonly index: number
  readonly via: 'exact' | 'convert' | RecordViewPlan
}

export type RecordViewPlan =
  | { readonly kind: 'owned'; readonly plan: OwnedRecordPlan }
  /** The one arm of a sum the source can become; `payload` null when the registry converts the pair without a view. */
  | {
      readonly kind: 'arm'
      readonly source: Representation
      readonly target: TaggedUnion
      readonly index: number
      readonly payload: RecordViewPlan | null
    }
  | {
      readonly kind: 'optional'
      readonly target: Extract<Representation, { kind: 'optional' }>
      readonly sourceOptional: boolean
      readonly payload: RecordViewPlan
    }
  /**
   * A `!`-asserted optional payload viewed onto a non-optional record-shaped
   * target: the source carrier is still `optional(...)` (the checker's
   * declared return type, e.g. `PropertyDescriptor | undefined`), but the
   * language-level `!` erased it, so the target the binding actually needs is
   * bare. `payload` is the view from the optional's payload onto `target`.
   */
  | {
      readonly kind: 'assert'
      readonly target: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
      readonly payload: RecordViewPlan
    }
  | { readonly kind: 'recast-union'; readonly source: TaggedUnion; readonly target: TaggedUnion; readonly arms: readonly RecastArmPlan[] }
  | {
      readonly kind: 'fields'
      readonly source: RecordViewSource
      readonly target: RecordViewTarget
      readonly fields: readonly RecordFieldPlan[]
      /** Index sidecars carried over, in the target's order. */
      readonly indexes: readonly { readonly target: RecordIndexSidecar; readonly source: RecordIndexSidecar }[]
      /** A string-keyed dynamic sidecar the source carries and the target's shape does not declare: re-attached, not dropped. */
      readonly expando: boolean
    }

export type PairConvertible = (source: Representation, target: Representation) => boolean

/**
 * Effects of an already-admitted view, not another conversion predicate.
 * Copying a held carrier (including an already-dynamic cell) reads native
 * storage directly. A converted field, bound method or expando needs its own
 * transport contract before this view can dispense with dynamic field hooks.
 */
export const recordViewUsesOnlyDirectFields = (plan: RecordViewPlan): boolean => {
  switch (plan.kind) {
    case 'owned':
      return true
    case 'optional':
    case 'assert':
      return recordViewUsesOnlyDirectFields(plan.payload)
    case 'arm': {
      const arm = plan.target.arms[plan.index]
      return plan.payload !== null
        ? recordViewUsesOnlyDirectFields(plan.payload)
        : arm !== undefined && representationKey(plan.source) === representationKey(arm.value)
    }
    case 'recast-union':
      return plan.arms.every((arm) => arm.via === 'exact' || (arm.via !== 'convert' && recordViewUsesOnlyDirectFields(arm.via)))
    case 'fields':
      return (
        !plan.expando &&
        plan.indexes.length === 0 &&
        plan.fields.every(
          ({ field, read }) =>
            read.kind === 'absent' || (read.kind === 'held' && representationKey(read.held.value) === representationKey(field.value))
        )
      )
  }
}

const abiOf = (member: Representation): { readonly receiver: unknown; readonly restFrom: unknown } | null =>
  'abi' in member && member.abi !== null && typeof member.abi === 'object' ? (member.abi as { receiver: unknown; restFrom: unknown }) : null

/** Whether viewing `source` as `arm` puts a non-dynamic source field into a `dynamic` (or `dynamic | undefined`) target field. */
const widensFieldIntoDynamic = (layouts: RecordLayoutPolicy, source: Representation, arm: Representation): boolean => {
  const sourceFields =
    source.kind === 'record' || source.kind === 'record-with-index'
      ? source.fields
      : source.kind === 'native-record-ref'
        ? layouts.forShape(source.shapeId)
        : null
  const armFields = arm.kind === 'record' ? arm.fields : arm.kind === 'native-record-ref' ? layouts.forShape(arm.shapeId) : null
  if (sourceFields === null || armFields === null) return false
  const isDynamic = (value: Representation): boolean =>
    value.kind === 'dynamic' || (value.kind === 'optional' && value.payload.kind === 'dynamic')
  return sourceFields.some((held) => {
    const field = armFields.find((candidate) => candidate.key === held.key)
    return field !== undefined && isDynamic(field.value) && !isDynamic(held.value)
  })
}

export const structuralRecordViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  convertible: PairConvertible
): RecordViewPlan | null => {
  if (source.kind === 'record' && target.kind === 'tagged-union') {
    const plan = ownedRecordMaterializationPlan(source, target, layouts)
    if (plan !== null) return { kind: 'owned', plan }
  }
  const sourceCanViewRecord =
    source.kind === 'record' ||
    source.kind === 'record-with-index' ||
    source.kind === 'native-record-ref' ||
    (source.kind === 'class-ref' && source.ownership === 'shared-refcount')
  // A shared record can be narrower than the record arm selected for a
  // field's physical union; the ordinary sum widener preserves identity and
  // cannot re-layout it. Exactly one arm the source can become is the answer.
  if (sourceCanViewRecord && target.kind === 'tagged-union') {
    const homes: { readonly index: number; readonly payload: RecordViewPlan | null }[] = []
    for (const [index, arm] of target.arms.entries()) {
      if (convertible(source, arm.value)) {
        homes.push({ index, payload: null })
        continue
      }
      const payload = structuralRecordViewPlan(layouts, source, arm.value, convertible)
      if (payload !== null) homes.push({ index, payload })
    }
    // Two arms can both accept the record and still not be equal answers:
    // `IteratorResult<number>` is `IteratorYieldResult<number> |
    // IteratorReturnResult<any>`, and `{ value: i++, done: false }` fits the
    // yield arm as written and the return arm only by BOXING `value` into its
    // `any`. Boxing is a widening the program never asked for -- the record
    // is already a value of the arm that holds its fields as they are -- so
    // when exactly one home takes the record without widening a field into
    // `dynamic`, that home is the answer, and the ambiguity guard below is
    // reserved for arms that genuinely tie.
    const exact = homes.length > 1 ? homes.filter((candidate) => !widensFieldIntoDynamic(layouts, source, target.arms[candidate.index]!.value)) : homes
    const home = exact.length === 1 ? exact[0] : undefined
    return home === undefined ? null : { kind: 'arm', source, target, index: home.index, payload: home.payload }
  }
  // The optional wrapper is peeled on both sides first: the question is about
  // the two RECORD carriers, and an absence is answered by the optional's own
  // presence flag either way.
  if (target.kind === 'optional') {
    const inner = source.kind === 'optional' ? source.payload : source
    const payload = structuralRecordViewPlan(layouts, inner, target.payload, convertible)
    return payload === null ? null : { kind: 'optional', target, sourceOptional: source.kind === 'optional', payload }
  }
  // The mirror case: the TARGET has already had its optional erased by a `!`
  // assertion (a declared return like `PropertyDescriptor | undefined`, read
  // past a non-null assertion into a bare-record slot), but the source is
  // still `optional(...)`. `narrowing`'s present-optional unwrap
  // (`targets/cpp/conversions.ts`) only installs when the payload's own
  // shape already equals the target's -- exactly the case that does NOT need
  // a view. When the payload is a differently-interned shape (a per-overload
  // host record vs. the canonical layout the binding declares) the unwrap has
  // nothing to chain to, so the view has to reach past the optional itself.
  if (source.kind === 'optional' && (target.kind === 'record' || target.kind === 'native-record-ref')) {
    const payload = structuralRecordViewPlan(layouts, source.payload, target, convertible)
    return payload === null ? null : { kind: 'assert', target, payload }
  }
  if (source.kind === 'tagged-union' && target.kind === 'tagged-union') return recastUnionPlan(layouts, source, target, convertible)
  const sourceIsRecord = source.kind === 'record' || source.kind === 'record-with-index' || source.kind === 'native-record-ref'
  if (!sourceIsRecord && (source.kind !== 'class-ref' || source.ownership !== 'shared-refcount')) return null
  if (source.kind === 'native-record-ref' && source.native !== null) return null
  if (target.kind !== 'native-record-ref' && target.kind !== 'record') return null
  if (target.kind === 'native-record-ref' && target.native !== null) return null
  const targetIndexes = target.kind === 'record' ? [] : (layouts.indexesForShape?.(target.shapeId) ?? [])
  if (targetIndexes.length > 0) {
    if (
      source.kind !== 'record-with-index' ||
      source.indexes.length !== targetIndexes.length ||
      !targetIndexes.every((targetIndex, index) => {
        const sourceIndex = source.indexes[index]
        return (
          sourceIndex !== undefined &&
          sourceIndex.key === targetIndex.key &&
          representationKey(sourceIndex.value) === representationKey(targetIndex.value)
        )
      })
    )
      return null
  } else if (source.kind === 'record-with-index') return null
  if (target.kind === 'native-record-ref' && (layouts.accessorsForShape?.(target.shapeId) ?? []).length > 0) return null
  const targetFields = target.kind === 'record' ? target.fields : layouts.forShape(target.shapeId)
  const sourceFields = source.kind === 'record' || source.kind === 'record-with-index' ? source.fields : layouts.forShape(source.shapeId)
  if (targetFields === null || sourceFields === null) return null
  // A record asserted to a wider shape that only adds members (`m[method] as
  // HandlerSet<T> & { params }`, whose program writes `params` next) holds
  // nothing a required added member could be read from: the language leaves
  // it undefined until the write, and the view starts it value-initialized.
  const onlyAdds =
    (source.kind === 'record' || source.kind === 'native-record-ref') &&
    sourceFields.length < targetFields.length &&
    sourceFields.every((held) => targetFields.some((field) => field.key === held.key))
  const fields: RecordFieldPlan[] = []
  for (const field of targetFields) {
    // A class method appears in the checker's structural field list, but it
    // is not physical storage in the emitted class: the projected class
    // member is the authority, and its receiver is bound into the callable
    // member the interface record stores.
    const abi = abiOf(field.value)
    if (
      source.kind === 'class-ref' &&
      abi !== null &&
      abi.receiver === null &&
      abi.restFrom === null &&
      layouts.classMethodFor?.(source.declaration, field.key) === true
    ) {
      fields.push({ field, read: { kind: 'bound-method' } })
      continue
    }
    // Same fact one member kind over: `layouts.forShape` names a class's
    // PHYSICAL storage, so a member backed by a getter is absent from it
    // although every read of the class answers. Calling the getter is the
    // read -- and asking before the field lookup is safe because a class
    // never declares a key as both storage and an accessor.
    if (source.kind === 'class-ref') {
      const accessor = layouts.classAccessorFor?.(source.declaration, field.key) ?? null
      if (accessor !== null) {
        if (!convertible(accessor, field.value)) return null
        fields.push({ field, read: { kind: 'class-accessor', value: accessor } })
        continue
      }
    }
    const held = sourceFields.find((candidate) => candidate.key === field.key)
    if (!held) {
      if (field.required && !onlyAdds) return null
      fields.push({ field, read: { kind: 'absent' } })
      continue
    }
    if (!convertible(held.value, field.value)) return null
    fields.push({ field, read: { kind: 'held', held } })
  }
  const indexes: { target: RecordIndexSidecar; source: RecordIndexSidecar }[] = []
  if (targetIndexes.length > 0 && source.kind === 'record-with-index') {
    for (const targetIndex of targetIndexes) {
      const sourceIndex = source.indexes.find((index) => index.key === targetIndex.key)
      if (!sourceIndex) return null
      indexes.push({ target: targetIndex, source: sourceIndex })
    }
  }
  const expando =
    targetIndexes.length === 0 &&
    target.kind === 'native-record-ref' &&
    source.kind === 'record-with-index' &&
    source.indexes.length === 1 &&
    source.indexes[0]?.key === 'string' &&
    source.indexes[0]?.value.kind === 'dynamic'
  return { kind: 'fields', source, target, fields, indexes, expando }
}

const recastUnionPlan = (
  layouts: RecordLayoutPolicy,
  source: TaggedUnion,
  target: TaggedUnion,
  convertible: PairConvertible
): RecordViewPlan | null => {
  const arms: RecastArmPlan[] = []
  for (const arm of source.arms) {
    const key = representationKey(arm.value)
    const exact = target.arms.findIndex((candidate) => representationKey(candidate.value) === key)
    if (exact >= 0) {
      arms.push({ index: exact, via: 'exact' })
      continue
    }
    let home: RecastArmPlan | null = null
    for (const [index, candidate] of target.arms.entries()) {
      if (convertible(arm.value, candidate.value)) {
        home = { index, via: 'convert' }
        break
      }
      const viewed = structuralRecordViewPlan(layouts, arm.value, candidate.value, convertible)
      if (viewed !== null) {
        home = { index, via: viewed }
        break
      }
    }
    if (home === null) return null
    arms.push(home)
  }
  return { kind: 'recast-union', source, target, arms }
}
