import type { CallableAbi, RecordField, RecordIndexSidecar, Representation } from '../representation/model.js'
import { representationKey, standInRefuses } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import type { FunctionId } from '../identity/ids.js'

/**
 * One record viewed as another whose declared shape it satisfies -- the
 * decision, without any spelling.
 *
 * `type A = Named & { age: number }` and `({ ...base, ...extra })` describe
 * one shape and intern as two, so they derive two record carriers under two
 * shape ids; a class instance handed to a parameter typed by an interface it
 * implements is the same pair one level up. The C++ backend spells each as a
 * struct, and a value of one is not a value of the other, so the view REBUILDS
 * the target from the source's members: field by field, a class method viewed
 * through the callable member's native convention, an optional peeled on
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
  if (standInRefuses(source, target)) return null
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
  /** A class method stored in a receiverless member frame; each call supplies its logical receiver. */
  | {
      readonly kind: 'bound-method'
      /**
       * The member's frame IS the method's own -- the same parameter
       * carriers, and a result that is either the method's own or dropped
       * (`void`) -- so the finite adapter forwards the arguments in that
       * native frame (`boundMethodFrameIsNative`). The function retains its
       * evaluated identity rather than capturing the source instance.
       */
      readonly nativeFrame?: true
    }
  /**
   * A class method the target stores with its receiver still a formal: the
   * prototype's own function object, unbound. `{ write: Stream['write'] }`
   * declares the member by the METHOD's type, whose convention leads with the
   * class receiver. Each invocation supplies its logical receiver; the native
   * receiver protocol authenticates that handle or its view origin for the
   * physical frame. An extracted function still receives the later call's
   * receiver, including `undefined` on an ordinary unbound call.
   */
  | { readonly kind: 'method-value' }
  /**
   * A class ACCESSOR the target stores as a plain field: read by calling the
   * getter. `value` is the carrier the getter publishes, which the field is
   * built from.
   */
  | { readonly kind: 'class-accessor'; readonly value: Representation }
  /** A native record getter produces its physical result at Get time. */
  | {
      readonly kind: 'record-accessor'
      readonly getter: FunctionId
      readonly setter: FunctionId | null
      readonly value: Representation
      readonly write: Representation | null
    }
  /** An optional field the source does not carry: default-constructed, presence false. */
  | { readonly kind: 'absent' }
  /** A shared alias forwards an undeclared key's native descriptor. Its
   * actual source allocation/writer receipt selects storage at Get/Set time;
   * allocating this view neither samples a value nor licenses a dynamic box.
   */
  | { readonly kind: 'native-descriptor' }
  /**
   * A field the source's layout does not declare, read from the
   * source's identity-keyed dynamic-property sidecar and converted checked
   * into the field's carrier: present exactly when the sidecar holds a
   * defined value under the key (a required field reads value-initialized otherwise).
   */
  | {
      readonly kind: 'sidecar'
      /**
       * `index`: an open source's own string index, not the identity-keyed
       * table -- the key a closed target names that the open document keeps
       * among its dynamic members.
       */
      readonly from?: 'index'
    }
  /** The source's own field, converted by the registry's pair answer. */
  | { readonly kind: 'held'; readonly held: RecordField }
  /**
   * The source's own field, built as the target field's shape by a nested
   * view -- a field the registry has no pair answer for, but which is itself
   * a record the target's field shape views (a class's private-state field
   * `s: Private`, read through an interface declaring `s: { namespace }`).
   */
  | { readonly kind: 'view'; readonly held: RecordField; readonly plan: RecordViewPlan }

export interface RecordFieldPlan {
  readonly field: RecordField
  readonly read: RecordFieldRead
}

/** One source arm's home in the target sum: the same carrier, a pair the registry converts, or a nested view. */
export interface RecastArmPlan {
  readonly index: number
  readonly via: 'exact' | 'convert' | RecordViewPlan
}

/** One source arm of a `dispatch` plan, in the source's own arm order. */
export interface DispatchArmPlan {
  readonly via: 'exact' | 'convert' | 'absent' | RecordViewPlan
}

export const isRecordViewTarget = (value: Representation): value is RecordViewTarget =>
  value.kind === 'record' || (value.kind === 'native-record-ref' && value.native === null)

/** Whether this view dispatches on a sum's live arm somewhere along its spine (`dispatch`, possibly under an optional or an assert). */
export const recordViewDispatchesArms = (plan: RecordViewPlan): boolean =>
  plan.kind === 'dispatch' ||
  plan.kind === 'iterator-result' ||
  ((plan.kind === 'optional' || plan.kind === 'assert') && recordViewDispatchesArms(plan.payload))

export type RecordViewPlan =
  | { readonly kind: 'owned'; readonly plan: OwnedRecordPlan }
  /** The one arm of a sum the source can become; `payload` null when the registry converts the pair without a view. */
  | {
      readonly kind: 'arm'
      readonly source: Representation
      readonly target: TaggedUnion
      readonly index: number
      readonly payload: RecordViewPlan | null
      /**
       * The operand is `optional(source)` and the target sum names its
       * absence as arm `absentIndex`: an empty operand enters that arm, a
       * present one enters arm `index` through `payload`. `source` is the
       * optional's payload, so every walker reads the present pair as is.
       */
      readonly absentIndex?: number
    }
  | {
      readonly kind: 'optional'
      readonly target: Extract<Representation, { kind: 'optional' }>
      readonly sourceOptional: boolean
      /**
       * The source is a bare `gea::Ref<C>` that `optional.ts` collapsed `C |
       * null` onto, entering a slot whose own absence is `null`: its empty
       * handle IS that null, so it is tested before the payload views it.
       */
      readonly sourceNullableReference?: true
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
  /**
   * A sum every arm of which reaches ONE record-shaped target: dispatched on
   * the live arm, never selected. `const ctx: AudioContextLike | null = Ctor ?
   * new Ctor() : createNativeAudioContext()` stores a `record | class` into
   * the interface's slot; the class arm is a structural view of the record
   * and the record arm is itself. Selecting the exact arm (`get<k>()`) read
   * the class instance's bytes as the record whenever the native host was the
   * live one. An `absent` arm is the target optional's own absence.
   */
  | {
      readonly kind: 'dispatch'
      readonly source: TaggedUnion
      readonly target: RecordViewTarget | Extract<Representation, { kind: 'optional' }>
      readonly arms: readonly DispatchArmPlan[]
    }
  /**
   * A record whose `done` is a plain `boolean` entering `IteratorResult<T>`:
   * built at the return arm when `done` holds `true` and at the yield arm
   * otherwise, because that is the one thing the value's own `done` says and
   * no carrier does. The checker admits `{ value, done: false }` by its
   * literal, and structural normalization keeps no boolean literal, so both
   * arms of an `IteratorResult<any>` -- whose `value`s are both `any` -- take
   * the record equally well by layout (a hand-written iterator's `next()`).
   */
  | {
      readonly kind: 'iterator-result'
      readonly source: RecordViewSource
      readonly target: TaggedUnion
      readonly yieldHome: IteratorResultHome
      readonly returnHome: IteratorResultHome
    }
  | {
      readonly kind: 'fields'
      readonly source: RecordViewSource
      readonly target: RecordViewTarget
      readonly fields: readonly RecordFieldPlan[]
      /** Index sidecars carried over, in the target's order. */
      readonly indexes: readonly { readonly target: RecordIndexSidecar; readonly source: RecordIndexSidecar }[]
      /**
       * A string-keyed dynamic sidecar the source carries and the target's
       * shape does not declare: re-attached to the view's expando, less the
       * keys the target names (those were read into its fields), not dropped.
       */
      readonly expando: boolean
      /** Named source fields a closed target does not declare, re-attached to the view's expando. */
      readonly expandoSpilled?: readonly RecordField[]
      /**
       * Named source fields the target does not declare, written into the
       * target's string index -- an own property of the source is one of the
       * view's too, and the index is where the target keeps keys it does not
       * name. Absent when there are none.
       */
      readonly spilled?: readonly { readonly held: RecordField; readonly index: RecordIndexSidecar }[]
    }

/** One arm of an `iterator-result` plan; `payload` null when the registry converts the pair without a view. */
export interface IteratorResultHome {
  readonly index: number
  readonly payload: RecordViewPlan | null
}

export type PairConvertible = (source: Representation, target: Representation, role?: 'sum-home' | 'field-read') => boolean

/**
 * The keys the family members a conversion SITE named declare, per family
 * layout (`native-record-ref` shape id): the `declared` shape's
 * `familyMemberKeys`, joined over every member of one family the site's type
 * names (two members of one family are one arm of one layout, and a value of
 * either may hold what either declares).
 *
 * The layout is the union of every member's fields, so a target read by its
 * layout alone may demand a field the named member never declares, from a
 * source whose same-named field is unrelated: one options type carries
 * `metadata: Promise<Metadata>`, while another member's layout holds its
 * family-mate's `metadata?: Document`. Where the site says
 * which member it named, a field that member does not declare and the source
 * cannot fill is ABSENT -- the answer a lone layout of that member gives,
 * since it has no such field at all -- and every field the member does
 * declare is read exactly as without this fact. Only the plan the site asked
 * for sees it: a nested field view is a field's own declared type, which no
 * site named.
 */
export type FamilyMemberKeys = ReadonlyMap<string, ReadonlySet<string>>

/**
 * Effects of an already-admitted view, not another conversion predicate.
 * Copying a held carrier (including an already-dynamic cell) reads native
 * storage directly. A converted field, bound method or expando needs its own
 * transport contract before this view can dispense with dynamic field hooks.
 */
/**
 * Whether a native class method fills a view member without converting
 * anything: every parameter carrier is the method's own, and the result is the
 * method's own or discarded by a `void` member. The finite callable view
 * passes the arguments through their native frame and retains the original
 * Function object. Its logical receiver is supplied by each invocation. A
 * member declaring `unknown` where the method returns `this` publishes that
 * result through the dynamic boundary.
 */
const boundMethodFrameIsNative = (member: CallableAbi, own: CallableAbi | null): boolean =>
  own !== null &&
  member.restFrom === own.restFrom &&
  member.argumentsFrame === own.argumentsFrame &&
  member.parameters.length === own.parameters.length &&
  member.parameters.every((parameter, index) => {
    const held = own.parameters[index]
    return held !== undefined && representationKey(held.value) === representationKey(parameter.value)
  }) &&
  (member.result.kind === 'void' || representationKey(member.result) === representationKey(own.result))

/**
 * `heldPairUnused(from, to)`: the conversion registry's claim that converting a
 * held field between two different carriers reads no field protocol. Without
 * it only an identical carrier counts as direct.
 */
const fieldReadIsDirect = (
  field: RecordField,
  read: RecordFieldRead,
  direct: (plan: RecordViewPlan) => boolean,
  heldPairUnused: PairConvertible | undefined
): boolean =>
  read.kind === 'absent' ||
  // Installing a descriptor forwarder performs no Get. Actual observations
  // need their own source/all-writer receipt and conversion citations.
  read.kind === 'native-descriptor' ||
  (read.kind === 'held' &&
    (representationKey(read.held.value) === representationKey(field.value) ||
      (heldPairUnused !== undefined && heldPairUnused(read.held.value, field.value)))) ||
  (read.kind === 'view' && direct(read.plan)) ||
  (read.kind === 'bound-method' && read.nativeFrame === true)

export const recordViewUsesOnlyDirectFields = (plan: RecordViewPlan, heldPairUnused?: PairConvertible): boolean => {
  const direct = (inner: RecordViewPlan): boolean => recordViewUsesOnlyDirectFields(inner, heldPairUnused)
  switch (plan.kind) {
    case 'owned':
      return true
    case 'optional':
    case 'assert':
      return direct(plan.payload)
    case 'arm': {
      const arm = plan.target.arms[plan.index]
      return plan.payload !== null
        ? direct(plan.payload)
        : arm !== undefined && representationKey(plan.source) === representationKey(arm.value)
    }
    case 'recast-union':
      return plan.arms.every((arm) => arm.via === 'exact' || (arm.via !== 'convert' && direct(arm.via)))
    case 'iterator-result':
      return [plan.yieldHome, plan.returnHome].every((home) => {
        const arm = plan.target.arms[home.index]
        return home.payload !== null
          ? direct(home.payload)
          : arm !== undefined && representationKey(plan.source) === representationKey(arm.value)
      })
    case 'dispatch':
      return plan.arms.every((arm) => arm.via === 'exact' || arm.via === 'absent' || (arm.via !== 'convert' && direct(arm.via)))
    case 'fields':
      return (
        !plan.expando &&
        plan.indexes.length === 0 &&
        plan.fields.every(({ field, read }) => fieldReadIsDirect(field, read, direct, heldPairUnused))
      )
  }
}

/** Diagnostic twin of `recordViewUsesOnlyDirectFields`: `key:readKind` for each read keeping a plan indirect. */
/**
 * What an INDIRECT view still needs from reflection. `emit-record-view.ts`
 * builds every `fields` view from the source's own C++ members and its
 * identity-keyed sidecar -- never through the source's field protocol -- so a
 * read that is not direct costs only its own per-field conversion: a sidecar
 * read adopts the dynamic value into the view's field (`field.value`), a held
 * read converts `held.value` into `field.value`. Those carriers are the
 * residual; the source record itself stays out of it. A
 * `conn.command(ns, cmd, options)` call views an options record into a shared
 * options record, and treating that view as an unknown boundary published the
 * options' `session` -- and every object graph behind it -- to full
 * reflection.
 *
 * `null` where a read's cost is not a per-field conversion this function
 * knows (an expando or index sidecar copy, a bound method, a class accessor,
 * a converting union arm): the caller keeps the whole-operand boundary.
 */
export const recordViewResidualReflection = (plan: RecordViewPlan, heldPairUnused?: PairConvertible): Representation[] | null => {
  const out: Representation[] = []
  const walk = (inner: RecordViewPlan): boolean => {
    switch (inner.kind) {
      case 'owned':
        return true
      case 'optional':
      case 'assert':
        return walk(inner.payload)
      case 'arm': {
        if (inner.payload !== null) return walk(inner.payload)
        const arm = inner.target.arms[inner.index]
        return arm !== undefined && representationKey(inner.source) === representationKey(arm.value)
      }
      case 'recast-union':
        return inner.arms.every((arm) => arm.via === 'exact' || (arm.via !== 'convert' && walk(arm.via)))
      case 'dispatch':
        return inner.arms.every((arm) => arm.via === 'exact' || arm.via === 'absent' || (arm.via !== 'convert' && walk(arm.via)))
      case 'iterator-result':
        return [inner.yieldHome, inner.returnHome].every((home) => {
          if (home.payload !== null) return walk(home.payload)
          const arm = inner.target.arms[home.index]
          return arm !== undefined && representationKey(inner.source) === representationKey(arm.value)
        })
      case 'fields':
        if (inner.expando || inner.indexes.length > 0) return false
        for (const { field, read } of inner.fields) {
          if (fieldReadIsDirect(field, read, () => false, heldPairUnused)) continue
          if (read.kind === 'view') {
            if (!walk(read.plan)) return false
          } else if (read.kind === 'sidecar') {
            // The existing dynamic entry may be an accessor. Its declared
            // dynamic receiver observes the original native object's fields,
            // even when the accessor returns only a primitive.
            out.push(inner.source, field.value)
          } else if (read.kind === 'held') out.push(read.held.value, field.value)
          else return false
        }
        return true
    }
  }
  return walk(plan) ? out : null
}

export const recordViewIndirectReads = (plan: RecordViewPlan, heldPairUnused?: PairConvertible): string[] => {
  switch (plan.kind) {
    case 'optional':
    case 'assert':
      return recordViewIndirectReads(plan.payload, heldPairUnused)
    case 'fields': {
      const out: string[] = []
      if (plan.expando) out.push('<expando>')
      if (plan.indexes.length > 0) out.push('<indexes>')
      for (const { field, read } of plan.fields) {
        if (read.kind === 'view') out.push(...recordViewIndirectReads(read.plan, heldPairUnused).map((inner) => `${field.key}.${inner}`))
        else if (!fieldReadIsDirect(field, read, () => true, heldPairUnused))
          out.push(
            read.kind === 'held'
              ? `${field.key}:held[${representationKey(read.held.value).slice(0, 90)} => ${representationKey(field.value).slice(0, 90)}]`
              : `${field.key}:${read.kind}`
          )
      }
      return out
    }
    default:
      return recordViewUsesOnlyDirectFields(plan, heldPairUnused) ? [] : [`<${plan.kind}>`]
  }
}

/**
 * Whether a native class method can receive an interface member's arguments
 * as they arrive: always without a rest parameter, and with one only where the
 * method packs the SAME rest at the same position -- `EventEmitter.emit(name,
 * ...args)` behind a `{ emit(name: string, ...args: unknown[]): boolean }`
 * member. The packed array is forwarded, never re-spread, so its carrier must
 * be the method's own.
 */
export const restForwards = (member: CallableAbi, own: CallableAbi | null, convertible?: PairConvertible): boolean => {
  if (own !== null && member.argumentsFrame !== own.argumentsFrame) return false
  if (member.restFrom === null) return own === null || own.restFrom === null || restPacks(member, own, convertible)
  if (own === null || own.restFrom !== member.restFrom || own.parameters.length !== member.parameters.length) return false
  const rest = member.parameters[member.restFrom]
  const ownRest = own.parameters[member.restFrom]
  return rest !== undefined && ownRest !== undefined && representationKey(rest.value) === representationKey(ownRest.value)
}

/**
 * A member of FIXED parameters viewed as a method whose frame ends in a rest
 * Array: a subclass's `emit(event, state, newState)` backed by
 * `EventEmitter.emit(event, ...args)`. The member's arguments from the rest
 * position on are exactly what the method's Array binds, so the finite
 * callable adapter must pack them;
 * forwarding them one by one would call a body whose frame has no such
 * formals. Each packed argument must enter the Array's element carrier.
 */
export const restPacks = (member: CallableAbi, own: CallableAbi, convertible?: PairConvertible): boolean => {
  if (member.argumentsFrame === 'actual' || own.argumentsFrame === 'actual') return false
  if (member.restFrom !== null || own.restFrom === null || own.parameters.length !== own.restFrom + 1) return false
  if (member.parameters.length < own.restFrom) return false
  const rest = own.parameters[own.restFrom]?.value
  if (rest === undefined || rest.kind !== 'array-object' || rest.ownership !== 'shared-refcount' || rest.recursive !== undefined)
    return false
  const enters = (from: Representation, to: Representation): boolean =>
    convertible === undefined || representationKey(from) === representationKey(to) || convertible(from, to)
  return (
    member.parameters.slice(0, own.restFrom).every((parameter, ordinal) => {
      const formal = own.parameters[ordinal]
      return formal !== undefined && enters(parameter.value, formal.value)
    }) && member.parameters.slice(own.restFrom).every((parameter) => enters(parameter.value, rest.element))
  )
}

/** An optional member's callable payload, or the member itself: the frame that holds a present method. */
export const optionalMethodPayloadOf = (member: Representation): Representation =>
  member.kind === 'optional' && member.absence === 'undefined' && abiOf(member.payload) !== null ? member.payload : member

const abiOf = (member: Representation): { readonly receiver: unknown; readonly restFrom: unknown } | null =>
  'abi' in member && member.abi !== null && typeof member.abi === 'object' ? (member.abi as { receiver: unknown; restFrom: unknown }) : null

/**
 * The two homes of a record that ties between `IteratorResult`'s arms, told
 * apart the way `prototype/emit-prototype-iterator.ts` tells them apart: the
 * return arm declares `done: true` (REQUIRED) and the yield arm `done?: false`
 * (optional). Only for a source whose own `done` is a required `boolean`,
 * which is the field the runtime choice is read from.
 */
const iteratorResultHomes = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: TaggedUnion,
  homes: readonly IteratorResultHome[]
): { readonly yieldHome: IteratorResultHome; readonly returnHome: IteratorResultHome } | null => {
  if (target.arms.length !== 2 || homes.length !== 2) return null
  const fieldsOf = (carrier: Representation): readonly RecordField[] | null =>
    carrier.kind === 'record' || carrier.kind === 'record-with-index'
      ? carrier.fields
      : carrier.kind === 'native-record-ref' && carrier.native === null
        ? layouts.forShape(carrier.shapeId)
        : null
  const sourceDone = fieldsOf(source)?.find((field) => field.key === 'done')
  if (sourceDone === undefined || !sourceDone.required || sourceDone.value.kind !== 'scalar' || sourceDone.value.domain !== 'boolean')
    return null
  const doneOf = (home: IteratorResultHome): RecordField | null => {
    const fields = target.arms[home.index] === undefined ? null : fieldsOf(target.arms[home.index]!.value)
    if (fields === null || !fields.some((field) => field.key === 'value')) return null
    return fields.find((field) => field.key === 'done') ?? null
  }
  const [first, second] = homes as [IteratorResultHome, IteratorResultHome]
  const firstDone = doneOf(first)
  const secondDone = doneOf(second)
  if (firstDone === null || secondDone === null || firstDone.required === secondDone.required) return null
  return firstDone.required ? { returnHome: first, yieldHome: second } : { returnHome: second, yieldHome: first }
}

/** Whether a carrier has a state for an absent value -- what an `undefined` a record really holds can be stored as. */
export const holdsAbsence = (carrier: Representation): boolean =>
  carrier.kind === 'optional' ||
  carrier.kind === 'dynamic' ||
  carrier.kind === 'undefined' ||
  carrier.kind === 'null' ||
  carrier.kind === 'void' ||
  (carrier.kind === 'tagged-union' && carrier.arms.some((arm) => holdsAbsence(arm.value)))

/** A record-reference carrier, whose value-initialized state is the null reference rather than a constructed value. */
const isNullableReferenceField = (value: Representation): boolean => value.kind === 'native-record-ref' && value.native === null

/** Whether a member convention's receiver is the viewed class itself or one of its bases: an instance of `source` is a value of it. */
const receivesInstanceOf = (receiver: unknown, source: Extract<Representation, { kind: 'class-ref' }>): boolean => {
  if (receiver === null || typeof receiver !== 'object') return false
  const carrier = receiver as Representation
  return (
    carrier.kind === 'class-ref' &&
    carrier.ownership === source.ownership &&
    (carrier.declaration === source.declaration || source.ancestors.includes(carrier.declaration))
  )
}

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
  convertible: PairConvertible,
  members?: FamilyMemberKeys
): RecordViewPlan | null => {
  if (standInRefuses(source, target)) return null
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
      // A record is a present value, so a sum's absence arm is never its
      // home. The chain still answers record -> `undefined`: its
      // `unreachable-value` step DISCARDS a value flow analysis proved a read
      // yields as `undefined`. Counted as a home, that discard tied with the
      // record's real arm in every `Options | null = null` formal (`new
      // Description(..., options)`), and the tie refused the pair;
      // where it was the ONLY home it certified a discard, and a library's
      // `callback(error)` into `(err?: Error | null)` passed `undefined`.
      if (arm.value.kind === 'undefined' || arm.value.kind === 'null' || arm.value.kind === 'void') continue
      if (convertible(source, arm.value, 'sum-home')) {
        homes.push({ index, payload: null })
        continue
      }
      const payload = structuralRecordViewPlan(layouts, source, arm.value, convertible, members)
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
    // `IteratorResult`'s two arms are told apart by `done` at RUNTIME whenever
    // both can take the record: boolean literals do not survive structural
    // normalization, so `{ value, done: false }` and `{ value, done:
    // finished }` are one source carrier, and picking an arm statically -- the
    // yield arm because it holds `value` unboxed, or the return arm because
    // its `value: any` takes anything -- answers wrongly for one of them.
    const byDone = iteratorResultHomes(layouts, source, target, homes)
    if (byDone !== null) return { kind: 'iterator-result', source, target, ...byDone }
    const exact =
      homes.length > 1 ? homes.filter((candidate) => !widensFieldIntoDynamic(layouts, source, target.arms[candidate.index]!.value)) : homes
    const home =
      exact.length === 1 ? exact[0] : (widestHome(layouts, target, exact) ?? heldRequiredKeysHome(layouts, source, target, exact))
    if (home !== undefined) return { kind: 'arm', source, target, index: home.index, payload: home.payload }
    return null
  }
  // `requireImageRecord(image)` passes `optional(A | B)` into `undefined
  // | null | (B | B[])`: the target sum carries the optional's absence as its
  // own arm, so the optional is not peeled into one arm -- its empty state is
  // the absence arm and only its payload looks for a present home. The sum
  // widener cannot answer it: `ofArm` takes a payload equal to the arm.
  if (source.kind === 'optional' && target.kind === 'tagged-union') {
    const absentIndex = target.arms.findIndex((arm) => arm.value.kind === source.absence)
    if (absentIndex >= 0) {
      const homes: { readonly index: number; readonly payload: RecordViewPlan | null }[] = []
      for (const [index, arm] of target.arms.entries()) {
        if (arm.value.kind === 'undefined' || arm.value.kind === 'null' || arm.value.kind === 'void') continue
        if (convertible(source.payload, arm.value, 'sum-home')) {
          homes.push({ index, payload: null })
          continue
        }
        const payload = structuralRecordViewPlan(layouts, source.payload, arm.value, convertible, members)
        if (payload !== null) homes.push({ index, payload })
      }
      const home = homes.length === 1 ? homes[0] : undefined
      if (home !== undefined) return { kind: 'arm', source: source.payload, target, index: home.index, payload: home.payload, absentIndex }
    }
  }
  // A bare sum carrying the target optional's absence as an ARM: the absent
  // arm is the optional's empty state and every other arm dispatches into
  // the payload, so the optional cannot be peeled first here.
  if (target.kind === 'optional' && source.kind === 'tagged-union' && isRecordViewTarget(target.payload)) {
    const dispatched = dispatchUnionPlan(layouts, source, target, convertible, members)
    if (dispatched !== null) return dispatched
  }
  // The optional wrapper is peeled on both sides first: the question is about
  // the two RECORD carriers, and an absence is answered by the optional's own
  // presence flag either way.
  if (target.kind === 'optional') {
    const inner = source.kind === 'optional' ? source.payload : source
    const payload = structuralRecordViewPlan(layouts, inner, target.payload, convertible, members)
    if (payload === null) return null
    const nullableReference = source.kind === 'class-ref' && source.ownership === 'shared-refcount' && target.absence === 'null'
    return {
      kind: 'optional',
      target,
      sourceOptional: source.kind === 'optional',
      ...(nullableReference ? { sourceNullableReference: true as const } : {}),
      payload
    }
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
    const payload = structuralRecordViewPlan(layouts, source.payload, target, convertible, members)
    return payload === null ? null : { kind: 'assert', target, payload }
  }
  if (source.kind === 'tagged-union' && target.kind === 'tagged-union')
    return recastUnionPlan(layouts, source, target, convertible, members)
  if (source.kind === 'tagged-union' && isRecordViewTarget(target)) return dispatchUnionPlan(layouts, source, target, convertible, members)
  const sourceIsRecord = source.kind === 'record' || source.kind === 'record-with-index' || source.kind === 'native-record-ref'
  if (!sourceIsRecord && (source.kind !== 'class-ref' || source.ownership !== 'shared-refcount')) return null
  if (source.kind === 'native-record-ref' && source.native !== null) return null
  if (target.kind !== 'native-record-ref' && target.kind !== 'record') return null
  if (target.kind === 'native-record-ref' && target.native !== null) return null
  const targetIndexes = target.kind === 'record' ? [] : layouts.indexesForShape(target.shapeId)
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
  } else if (source.kind === 'record-with-index' && !(openDocumentSource(source) && target.ownership === 'shared-refcount')) return null
  // An open document entering a CLOSED shape: `build(key, doc, { ...options,
  // multi: true })` hands the spread of a
  // `Document` to `Options & { multi?: boolean }`. The target's members
  // the source does not name live in the source's string index, so each is
  // read from there, checked; every other own key re-attaches to the view's
  // identity-keyed expando rather than being dropped. An owned target is a
  // value with no identity to hold those keys, so it keeps refusing.
  const closedFromOpen = source.kind === 'record-with-index' && targetIndexes.length === 0
  if (target.kind === 'native-record-ref' && (layouts.accessorsForShape(target.shapeId) ?? []).length > 0) return null
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
  const memberKeys = target.kind === 'native-record-ref' ? members?.get(target.shapeId) : undefined
  const fields: RecordFieldPlan[] = []
  for (const field of targetFields) {
    // A layout field the named member does not declare (`FamilyMemberKeys`)
    // is optional in the layout -- some member lacks it -- and a source that
    // cannot fill it holds an unrelated property of that name.
    const undeclaredByMember = memberKeys !== undefined && !memberKeys.has(field.key) && !field.required
    // A class method appears in the checker's structural field list, but it
    // is not physical storage in the emitted class: the projected class
    // member is the authority. Its physical receiver enters the native
    // receiver protocol of the callable member the interface stores; the
    // source instance is never captured by that function. An OPTIONAL method (`end?():
    // unknown`) is the same member, present: the class has the method, so
    // `typeof view.end === 'function'` must answer yes -- taking it as absent
    // made a stream library's `pipe` skip every destination's `end()`.
    const abi = abiOf(optionalMethodPayloadOf(field.value))
    if (
      source.kind === 'class-ref' &&
      abi !== null &&
      abi.receiver === null &&
      layouts.classMethodFor?.(source.declaration, field.key) === true &&
      restForwards(abi as CallableAbi, layouts.classMethodAbiFor?.(source.declaration, field.key) ?? null, convertible)
    ) {
      const nativeFrame = boundMethodFrameIsNative(abi as CallableAbi, layouts.classMethodAbiFor?.(source.declaration, field.key) ?? null)
      fields.push({ field, read: nativeFrame ? { kind: 'bound-method', nativeFrame: true } : { kind: 'bound-method' } })
      continue
    }
    if (
      source.kind === 'class-ref' &&
      abi !== null &&
      abi.restFrom === null &&
      receivesInstanceOf(abi.receiver, source) &&
      layouts.classMethodFor?.(source.declaration, field.key) === true
    ) {
      fields.push({ field, read: { kind: 'method-value' } })
      continue
    }
    // A member the target declares `unknown`/`any` (`Buffer.prototype?.describe`) still reads the class's method: the Function object itself,
    // crossing into the declared dynamic slot. Without this the method fell to
    // the "no such field" arm below and the view read `undefined`.
    if (
      source.kind === 'class-ref' &&
      optionalMethodPayloadOf(field.value).kind === 'dynamic' &&
      layouts.classMethodFor?.(source.declaration, field.key) === true
    ) {
      fields.push({ field, read: { kind: 'method-value' } })
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
        if (!convertible(accessor, field.value, 'field-read')) return null
        fields.push({ field, read: { kind: 'class-accessor', value: accessor } })
        continue
      }
    }
    if (source.kind === 'record' || (source.kind === 'native-record-ref' && source.native === null)) {
      const accessor = (source.kind === 'record' ? source.accessors : layouts.accessorsForShape(source.shapeId))?.find(
        (entry) => entry.key === field.key
      )
      if (accessor) {
        const getter = accessor.getter === null ? null : layouts.accessorAbiFor?.(accessor.getter)
        const setter = accessor.setter === null ? null : layouts.accessorAbiFor?.(accessor.setter)
        if (
          !getter ||
          getter.parameters.length !== 0 ||
          getter.restFrom !== null ||
          (accessor.setter !== null && (!setter || setter.parameters.length !== 1 || setter.restFrom !== null))
        )
          return null
        if (!convertible(getter.result, field.value, 'field-read')) return null
        fields.push({
          field,
          read: {
            kind: 'record-accessor',
            getter: accessor.getter!,
            setter: accessor.setter,
            value: getter.result,
            write: setter?.parameters[0]?.value ?? null
          }
        })
        continue
      }
    }
    const held = sourceFields.find((candidate) => candidate.key === field.key)
    if (!held && closedFromOpen) {
      if (field.required || !convertible(SIDECAR_VALUE, field.value)) return null
      fields.push({ field, read: { kind: 'sidecar', from: 'index' } })
      continue
    }
    if (!held) {
      if (field.required && !onlyAdds) return null
      if (
        !undeclaredByMember &&
        carriesDynamicSidecar(source) &&
        source.ownership === 'shared-refcount' &&
        target.ownership === 'shared-refcount'
      ) {
        fields.push({ field, read: { kind: 'native-descriptor' } })
        continue
      }
      // A shared record keeps every key its layout lacks in its identity-keyed
      // sidecar: `Object.assign({ first: 1 }, options)` leaves `options.limit`
      // there, and a view that starts `limit` absent drops it. An optional
      // member is read from that sidecar. So is a REQUIRED one:
      // `Object.assign({ relaxed, legacy }, options, { seenObjects })` hands
      // `seenObjects` on only through the sidecar, and a view that started it
      // value-initialized passed a null array on. A key the sidecar lacks
      // still reads back value-initialized (`onlyAdds`: the program writes it
      // next), and a carrier no dynamic value converts into keeps that start.
      if (!undeclaredByMember && carriesDynamicSidecar(source)) {
        // An owned copy needs a contextual sampling/presence proof. A public
        // typed field does not declare the source's unknown entries as any.
        return null
      }
      fields.push({ field, read: { kind: 'absent' } })
      continue
    }
    // A field holding `undefined` is a value the record really carries. The
    // chain admits `undefined` into a carrier with no absence only as `never`'s
    // dead branch (its `unreachable-value` step), and a view that took that
    // answer would build the arm over a throw: `{ value: undefined, done: true
    // }` fits `IteratorYieldResult<string>`'s `value: string` that way, and
    // chosen over the return arm it aborted every `closeHandler()` in
    // a hand-written async iterator.
    if (held.value.kind === 'undefined' && !holdsAbsence(field.value)) {
      if (!undeclaredByMember) return null
      fields.push({ field, read: { kind: 'absent' } })
      continue
    }
    if (convertible(held.value, field.value, 'field-read')) {
      fields.push({ field, read: { kind: 'held', held } })
      continue
    }
    // A fresh literal's `null` placeholder asserted into a record-reference
    // field. A linked list builds its circular head as
    // `{ next: null, prev: null, value: null } as unknown as EmptyNode` and
    // links `next`/`prev` to itself on the next two lines; strict TypeScript
    // admits that literal only through the assertion. The reference starts
    // value-initialized -- the null reference -- until the write, exactly the
    // `onlyAdds` rule above for a member the source leaves undefined.
    if (source.kind === 'record' && source.ownership === 'owned' && held.value.kind === 'null' && isNullableReferenceField(field.value)) {
      fields.push({ field, read: { kind: 'absent' } })
      continue
    }
    const nested = nestedFieldViewPlan(layouts, held.value, field.value, convertible)
    if (nested === null) {
      if (!undeclaredByMember) return null
      fields.push({ field, read: { kind: 'absent' } })
      continue
    }
    fields.push({ field, read: { kind: 'view', held, plan: nested } })
  }
  const indexes: { target: RecordIndexSidecar; source: RecordIndexSidecar }[] = []
  if (targetIndexes.length > 0 && source.kind === 'record-with-index') {
    for (const targetIndex of targetIndexes) {
      const sourceIndex = source.indexes.find((index) => index.key === targetIndex.key)
      if (!sourceIndex) return null
      indexes.push({ target: targetIndex, source: sourceIndex })
    }
  }
  const expando = closedFromOpen
  const expandoSpilled: RecordField[] = []
  if (closedFromOpen) {
    for (const held of sourceFields) {
      if (targetFields.some((field) => field.key === held.key)) continue
      if (held.key.startsWith('sym(') || !convertible(held.value, SIDECAR_VALUE)) return null
      expandoSpilled.push(held)
    }
  }
  // An indexed source names fields an indexed target may not: `{ ...doc,
  // extra }` returned as an indexed document type. The target keeps such a key in its
  // string index, so the view writes it there rather than dropping an own
  // property. A symbol key has no string index to land in, and a value the
  // index cannot hold has no store: both refuse.
  const spilled: { held: RecordField; index: RecordIndexSidecar }[] = []
  if (targetIndexes.length > 0) {
    for (const held of sourceFields) {
      if (targetFields.some((field) => field.key === held.key)) continue
      const home = targetIndexes.find((index) => index.key === 'string')
      if (home === undefined || held.key.startsWith('sym(') || !convertible(held.value, home.value)) return null
      spilled.push({ held, index: home })
    }
  }
  return {
    kind: 'fields',
    source,
    target,
    fields,
    indexes,
    expando,
    ...(spilled.length > 0 ? { spilled } : {}),
    ...(expandoSpilled.length > 0 ? { expandoSpilled } : {})
  }
}

/** An open document: a record whose one index is a string-keyed dynamic sidecar. */
const openDocumentSource = (source: Extract<Representation, { kind: 'record-with-index' }>): boolean =>
  source.indexes.length === 1 && source.indexes[0]?.key === 'string' && source.indexes[0]?.value.kind === 'dynamic'

/** What a sidecar read answers before the field's checked conversion. */
const SIDECAR_VALUE: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

/**
 * A source whose identity carries the runtime's dynamic-property sidecar
 * (`gea::nativeDynamicGet`): a shared data record. An owned record is a value
 * with no identity to key a sidecar by, and a class's extra keys are the
 * class's own concern.
 */
const carriesDynamicSidecar = (source: RecordViewSource): boolean =>
  (source.kind === 'record' && source.ownership === 'shared-refcount') || source.kind === 'native-record-ref'

/**
 * Of several arms a record fits, the one whose keys include every other
 * candidate's, or `undefined` when none does.
 *
 * The record keeps all its keys at runtime, and whichever arm holds it drops
 * the ones that arm does not declare. A "failed" event record may fit both a
 * `StartedEvent` and a `FailedEvent` arm; the started arm would drop
 * `duration` and `failure`, so a later `'duration' in event` answers wrongly.
 * The arm that declares the most of them is the least lossy, and it is only
 * well defined when one arm's keys contain the rest -- two arms that each
 * keep a key the other drops are a genuine tie, still refused.
 */
/**
 * Among arms that tie on width, the one arm whose every REQUIRED key the
 * source record itself holds. TypeScript normalizes a union of object
 * literals by giving each the others' keys as optional `undefined` -- a
 * serializer that returns `{ data, width, height, type }` or `{}`, and the
 * `{}` arm becomes `{ data?: undefined, ... }` -- so both arms spell the same
 * key set and width cannot tell them apart. A plain record with no index
 * signature holds exactly its own fields; an arm demanding a key it lacks is
 * a view of data the value never carried.
 */
const heldRequiredKeysHome = <Home extends { readonly index: number }>(
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: TaggedUnion,
  homes: readonly Home[]
): Home | undefined => {
  if (homes.length < 2 || source.kind !== 'record') return undefined
  const held = new Set(source.fields.filter((field) => field.required).map((field) => field.key))
  const satisfied = homes.filter((home) => {
    const arm = target.arms[home.index]?.value
    const fields =
      arm?.kind === 'record' ? arm.fields : arm?.kind === 'native-record-ref' && arm.native === null ? layouts.forShape(arm.shapeId) : null
    return fields !== null && fields !== undefined && fields.every((field) => !field.required || held.has(field.key))
  })
  return satisfied.length === 1 ? satisfied[0] : undefined
}

const widestHome = <Home extends { readonly index: number }>(
  layouts: RecordLayoutPolicy,
  target: TaggedUnion,
  homes: readonly Home[]
): Home | undefined => {
  if (homes.length < 2) return undefined
  const keysOf = (index: number): ReadonlySet<string> | null => {
    const arm = target.arms[index]?.value
    const fields =
      arm?.kind === 'record' ? arm.fields : arm?.kind === 'native-record-ref' && arm.native === null ? layouts.forShape(arm.shapeId) : null
    return fields === null || fields === undefined ? null : new Set(fields.map((field) => field.key))
  }
  const keyed = homes.map((home) => ({ home, keys: keysOf(home.index) }))
  if (keyed.some((entry) => entry.keys === null)) return undefined
  const widest = keyed.filter((entry) => keyed.every((other) => [...other.keys!].every((key) => entry.keys!.has(key))))
  return widest.length === 1 ? widest[0]!.home : undefined
}

/**
 * A held field viewed as the target's field shape, one record level down.
 *
 * Only a DATA record is viewed here. A field that holds a class instance
 * keeps its identity, and a snapshot of it is not the object: a field holding
 * an `AudioParam` whose `value` setter drives the audio graph, viewed as a
 * `ParamLike` copy, would swallow every write
 * (`class-arm-without-view-into-interface-slot-refused.ts` states the
 * refusal that case keeps).
 *
 * A pair already under construction answers `null`: a record that reaches
 * itself through its fields would
 * otherwise recurse without end.
 */
const holdsClassInstance = (representation: Representation): boolean =>
  representation.kind === 'class-ref' ||
  (representation.kind === 'optional' && holdsClassInstance(representation.payload)) ||
  (representation.kind === 'tagged-union' && representation.arms.some((arm) => holdsClassInstance(arm.value)))

const nestedViewsInProgress = new Set<string>()
const nestedFieldViewPlan = (
  layouts: RecordLayoutPolicy,
  held: Representation,
  target: Representation,
  convertible: PairConvertible
): RecordViewPlan | null => {
  const inner = target.kind === 'optional' ? target.payload : target
  // A sum field is a record target too when one of its arms is: a
  // `preference` option typed `Preference | PreferenceMode | { mode?, tags?,
  // ... }`, where the option table stores a fresh
  // `{ ...options.preference, ...value }` there.
  // `structuralRecordViewPlan` enters the one arm the record can become, and
  // refuses a tie, exactly as it does for a top-level sum target.
  const reachesRecord =
    isRecordViewTarget(inner) || (inner.kind === 'tagged-union' && inner.arms.some((arm) => isRecordViewTarget(arm.value)))
  if (!reachesRecord || holdsClassInstance(held)) return null
  const key = `${representationKey(held)}->${representationKey(target)}`
  if (nestedViewsInProgress.has(key)) return null
  nestedViewsInProgress.add(key)
  try {
    return structuralRecordViewPlan(layouts, held, target, convertible)
  } finally {
    nestedViewsInProgress.delete(key)
  }
}

/**
 * Every arm of `source` reaching the one record-shaped `target` (or the
 * payload of an optional one), in the source's own arm order.
 *
 * Answered only when some arm reaches the target through a VIEW: a sum whose
 * arms are all exact or chain-convertible is the printer chain's own dispatch
 * (`emit-narrowing.ts`'s `taggedUnionArmText`), and repeating that answer
 * here would move every such program for nothing. An arm with no way to the
 * target refuses the whole plan: a dispatch that skipped an arm would be the
 * unchecked selection this plan exists to replace.
 */
const dispatchUnionPlan = (
  layouts: RecordLayoutPolicy,
  source: TaggedUnion,
  target: RecordViewTarget | Extract<Representation, { kind: 'optional' }>,
  convertible: PairConvertible,
  members?: FamilyMemberKeys
): RecordViewPlan | null => {
  const payload = target.kind === 'optional' ? target.payload : target
  if (!isRecordViewTarget(payload)) return null
  const key = representationKey(payload)
  const arms: DispatchArmPlan[] = []
  let viewed = false
  for (const arm of source.arms) {
    if (representationKey(arm.value) === key) {
      arms.push({ via: 'exact' })
      continue
    }
    if (target.kind === 'optional' && arm.value.kind === target.absence) {
      arms.push({ via: 'absent' })
      continue
    }
    if (convertible(arm.value, payload, 'sum-home')) {
      arms.push({ via: 'convert' })
      continue
    }
    const view = structuralRecordViewPlan(layouts, arm.value, payload, convertible, members)
    if (view === null) return null
    viewed = true
    arms.push({ via: view })
  }
  // A non-exact arm that converts is still a live value, even when another
  // arm already has the target's carrier. Selecting that exact arm would
  // discard the converted record. Every arm above has its own accepted
  // transport, so dispatch through those transports rather than selecting.
  const convertsAnArm = arms.some((arm) => arm.via === 'convert')
  return viewed || convertsAnArm ? { kind: 'dispatch', source, target, arms } : null
}

const recastUnionPlan = (
  layouts: RecordLayoutPolicy,
  source: TaggedUnion,
  target: TaggedUnion,
  convertible: PairConvertible,
  members?: FamilyMemberKeys
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
      if (convertible(arm.value, candidate.value, 'sum-home')) {
        home = { index, via: 'convert' }
        break
      }
      const viewed = structuralRecordViewPlan(layouts, arm.value, candidate.value, convertible, members)
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
