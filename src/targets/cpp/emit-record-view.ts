import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type { CallableAbi, Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { structuralRecordViewPlan, type RecordViewPlan } from '../../conversion/record-view.js'
import { classFamilyOverridesOf, virtualDispatchKey } from '../../projection/dispatch.js'
import { cppVirtualMemberName } from './virtual-methods.js'
import { classMemberOf } from './class-layout.js'
import {
  alignedValueText,
  boxedAssertionText,
  chainConverts,
  convertedValueText,
  dynamicCarrierBoxText,
  recastedUnionFromHomes,
  recastUnionArmText,
  type ConversionSite,
  type RecastUnionHome
} from './emit-narrowing.js'
import { ownedRecordMaterializationText } from './emit-owned-record.js'
import { cppRecordIndexAttributesNameFor, cppRecordIndexSidecarName, cppRecordIndexSidecarNameFor } from './records.js'
import {
  cppAbiParameterType,
  cppBodyName,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppTypeOf
} from './types.js'

/**
 * The renderer of the census's `view:structural-record` recipe
 * (`conversion/record-view.ts`): a record or class instance viewed as another
 * shape it satisfies. Its own module because both the chain's caller
 * (`emit-narrowing.ts`'s `alignedValueText`, which renders whatever recipe
 * the census names for a pair) and the call renderer (`emit-callable.ts`)
 * reach it, and the plan is the one authority on which pairs are views.
 */

/**
 * The structural-record-view plan, built once per `(layouts, source,
 * target)` and shared between the two places that ask for it:
 * `conversions.ts`'s `staticRecipe`, which tests whether a view exists at
 * all while the conversion census derives the pair's capability, and
 * `structuralRecordViewText` below, which spells the plan the census
 * already built. Without this cache the two independently ran
 * `structuralRecordViewPlan` -- decided the pair twice, the same defect this
 * refactor removes for the chain's own steps (`conversionRecipeOf`'s memo).
 *
 * Lives here rather than in `conversions.ts`: this module already sits
 * downstream of `emit-narrowing.ts` (for `chainConverts`) and
 * `conversions.ts` already sits upstream of `emit-narrowing.ts`, so a
 * `conversions.ts` import of this file adds one edge to an existing acyclic
 * chain, while the reverse (this file importing from `conversions.ts`)
 * would close `emit-narrowing.ts -> emit-record-view.ts -> conversions.ts
 * -> emit-narrowing.ts` into a cycle through a THIRD file, worse than the
 * two-file cycle `emit-narrowing.ts`/`emit-record-view.ts` already have.
 *
 * Keyed by object identity through nested `WeakMap`s, the same discipline
 * `emit-narrowing.ts`'s `spellability` memo uses, rather than a string key
 * built from `representationKey` -- so a compile's representations and its
 * plans are never retained past the compile that created them, and two
 * unrelated compiles sharing a coincidentally-equal key string can never
 * collide. `layouts` is the outermost key rather than an assumed-identical
 * singleton: the cache stays correct even if a caller ever passes a
 * different policy for the same pair, at the cost of one more miss, not a
 * wrong answer.
 */
const recordViewPlans = new WeakMap<RecordLayoutPolicy, WeakMap<Representation, WeakMap<Representation, RecordViewPlan | null>>>()

export const viewPlanFor = (layouts: RecordLayoutPolicy, source: Representation, target: Representation): RecordViewPlan | null => {
  let bySource = recordViewPlans.get(layouts)
  if (bySource === undefined) {
    bySource = new WeakMap()
    recordViewPlans.set(layouts, bySource)
  }
  let byTarget = bySource.get(source)
  if (byTarget === undefined) {
    byTarget = new WeakMap()
    bySource.set(source, byTarget)
  }
  if (byTarget.has(target)) return byTarget.get(target) ?? null
  const plan = structuralRecordViewPlan(layouts, source, target, chainConverts)
  byTarget.set(target, plan)
  return plan
}

const viewEnvironmentName = 'gea_view_env'
const viewSlotName = 'gea_view_slot'
const viewReceiverName = 'gea_view_this'
const viewArgumentName = (ordinal: number): string => `gea_view_arg_${ordinal}`

/**
 * A class METHOD as the member a structural view of that class needs.
 *
 * A class's methods are not storage: they are free functions taking the
 * instance as a leading formal, which is why `boundMethodValueRepresentation`
 * (`class-properties/emit-class-properties.ts`) has to ADD a receiver to the
 * carrier of a plain `obj.method` read. An interface that declares the same
 * method declares STORAGE for it -- a `gea::CallableObject` member with no
 * receiver in its frame -- so the two spellings of one method differ by
 * exactly the receiver, and nothing in `gea::CallableObject`'s four converting
 * constructors binds one.
 *
 * hono is where this stops the compile: `HonoBase.router` is declared
 * `Router<[H, RouterRoute]>` -- an interface whose members are `name`, `add`
 * and `match` -- and the constructor stores `new PatternRouter()` into it. The
 * class provides `name` as a field and the other two as methods, so the view
 * had two required members with no source field and refused, and the store
 * fell through to a raw assignment clang rejected.
 *
 * The binding is `gea::CallableObject`'s own public `(Invoke, void*)`
 * constructor over the receiver packed as the environment, which is the exact
 * shape every closure this backend emits already uses -- `packEnvironment`
 * keeps a heap copy (and therefore a reference count) for a carrier that can
 * outlive the frame, and the lambda unpacks it the same way a generated thunk
 * does. What it does NOT do is preserve identity: the view is a new object, so
 * a later write through the class reference is not seen through the view. That
 * is a real deviation, and it is the reason this is reached only after
 * `convertedValueText` has refused -- a pair with an identity-preserving
 * conversion never gets here.
 *
 * Refused, rather than rendered wrong, for a method that captures anything:
 * the environment slot is spent on the receiver, and a method with its own
 * captures needs both.
 */
const boundClassMethodText = (
  ctx: ConversionSite,
  source: Representation,
  member: Representation,
  key: string,
  text: string
): string | null => {
  // A view that refuses names only the PAIR, so which member refused is
  // invisible in the refusal -- and a record view is all-or-nothing, so one
  // member is the whole answer. Behind an env var because it is the only way
  // to attribute one.
  const trace = (why: string): null => {
    if (process.env['GEA_RECORD_VIEW_DEBUG']) console.log(`[VIEW] ${representationKey(source)} member ${key}: ${why}`)
    return null
  }
  if (source.kind !== 'class-ref' || source.ownership !== 'shared-refcount') return trace('source is not a shared-refcount class ref')
  const abi = 'abi' in member ? (member.abi as CallableAbi) : null
  if (abi === null || abi.receiver !== null || abi.restFrom !== null) return trace('member declares no plain callable abi')
  const site = classMemberOf(ctx.classes, source.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return trace('class has no callable method of that name')
  if (ctx.captures.of(site.method.callable).kind !== 'none') return trace('method captures, and the environment slot holds the receiver')
  const receiverType = cppTypeOf(source)
  const formals = abi.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} ${viewArgumentName(ordinal)}`)
  const actuals = abi.parameters.map((_, ordinal) => viewArgumentName(ordinal))
  const call = `${cppBodyName(site.method.callable)}(${[`*${viewReceiverName}`, ...actuals].join(', ')})`
  // A void-result member needs no conversion at all -- `call` is a statement,
  // not an expression the lambda hands back -- so only a non-void result asks
  // for the class's OWN declared signature, `ownAbi`. That is deliberately
  // NOT `abi`: `abi` is the INTERFACE member's declared signature the view is
  // being built for, and the two agree on the receiver and (in every program
  // seen so far) on the parameters, but nothing forces the class's own result
  // to already be the interface's -- a method the checker types to return
  // `this` (a typed class ref) can back an interface member the wider census
  // erased to `gea::Value`, and the body function genuinely returns the
  // narrower carrier. Symmetric with every other position this file converts
  // through (`recordFieldsViewText`'s field reads, the union arms below): the
  // census-backed `alignedValueText` (not a direct `convertedValueText` call
  // -- see `scripts/architecture.mjs`'s exact-count gate on this file) is the
  // one authority on turning one carrier into the other. E.g. `gea::Value`
  // has no implicit constructor from a `gea::Ref<T>`, so an unconverted
  // `return call;` compiled only when the two happened to already agree.
  // `representation` is OPTIONAL on a `ClassMethod`, and every callable kind
  // that carries a convention carries it under the same `abi` key -- `function`
  // is only the commonest of them. Reading it the same structural way the
  // member's own abi is read above keeps the two sides symmetric; narrowing to
  // `kind === 'function'` refused `Duplex.write` here, whose convention is
  // published under another callable kind entirely.
  const ownRepresentation = site.method.representation
  const ownAbi = ownRepresentation !== undefined && 'abi' in ownRepresentation ? (ownRepresentation.abi as CallableAbi) : null
  let returned = call
  // No published convention at all means there is nothing to compare against,
  // which is where this renderer stood before it converted anything: hand the
  // call back unchanged rather than refuse, since the two agree in every
  // program the emitted-set gate covers and a refusal here would drop them all.
  if (abi.result.kind !== 'void' && ownAbi !== null) {
    const converted = alignedValueText(ctx, 'emit-record-view.ts:158', ownAbi.result, abi.result, call)
    if (converted === null)
      return trace(
        `no conversion from the method's own result ${representationKey(ownAbi.result)} into the member's ${representationKey(abi.result)}`
      )
    returned = converted
  }
  const body =
    `alignas(void*) unsigned char ${viewSlotName}[sizeof(void*)]; ` +
    `auto* ${viewReceiverName} = gea::unpackEnvironment<${receiverType}>(${viewEnvironmentName}, ${viewSlotName}); ` +
    `${abi.result.kind === 'void' ? `${call};` : `return ${returned};`}`
  const invoke = `+[](void* ${viewEnvironmentName}${formals.length > 0 ? ', ' : ''}${formals.join(', ')}) -> ${cppResultTypeOf(abi.result)} { ${body} }`
  return `${cppTypeOf(member)}(${invoke}, gea::packEnvironment<${receiverType}>(${text}))`
}

/**
 * A getter-backed member, read by CALLING the getter -- the same answer
 * `emit-class-properties.ts` gives an ordinary `obj.member` read of an
 * accessor, and the reason a class's accessors can back an interface's plain
 * fields at all.
 *
 * The direct body call is only correct while the family is CLOSED at this
 * key: a derived class that redeclares the getter must run its own, and
 * nothing in a struct-building expression dispatches. That case is refused
 * rather than dispatched here because this renderer has no virtual-dispatch
 * table to reach for -- `ConversionSite` carries the class map and the
 * capture index, not the emitted member set -- and a wrong body is worse than
 * a named refusal.
 */
const classAccessorReadText = (
  ctx: ConversionSite,
  source: Representation,
  member: Representation,
  key: string,
  published: Representation,
  text: string
): string | null => {
  if (source.kind !== 'class-ref') return null
  const site = classMemberOf(ctx.classes, source.declaration, key)
  if (site === null || site.kind !== 'accessor' || site.accessor.getter === null) return null
  if (classFamilyOverridesOf(ctx.classes, source.declaration, key).length > 0) {
    // An overridden getter is read through the family's dispatch member, as a
    // plain read of it is (`emit-class-properties.ts`).
    const dispatch = ctx.virtualDispatch?.get(virtualDispatchKey(source.declaration, key, 'get'))
    if (dispatch === undefined) return null
    return alignedValueText(
      ctx,
      'emit-record-view.ts:classAccessorReadText',
      dispatch.result,
      member,
      `${text}->${cppVirtualMemberName(key, 'get')}()`
    )
  }
  return alignedValueText(
    ctx,
    'emit-record-view.ts:classAccessorReadText',
    published,
    member,
    `${cppBodyName(site.accessor.getter)}(${text})`
  )
}

/**
 * A record viewed as another shape it satisfies: the census's plan
 * (`conversion/record-view.ts`), rendered. The plan decides which pairs are
 * views and how each field is reached; this spells it. `null` only where the
 * plan promised what this context cannot spell -- a bound class method that
 * captures, whose environment slot is spent on the receiver -- which
 * `emitConvert` then refuses.
 *
 * `viewPlanFor` above is asked rather than `structuralRecordViewPlan`
 * directly: `conversions.ts`'s `staticRecipe` already built this same plan
 * to answer whether the census's `view:structural-record` capability exists
 * at all, and this is that plan's one consumer, not a second derivation of
 * it.
 */
export const structuralRecordViewText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const plan = viewPlanFor(ctx.layouts, source, target)
  return plan === null ? boxedAssertionText(source, target, text) : recordViewText(ctx, plan, text)
}

const recordViewText = (ctx: ConversionSite, plan: RecordViewPlan, text: string): string | null => {
  switch (plan.kind) {
    case 'owned':
      return ownedRecordMaterializationText(plan.plan, text)
    case 'arm': {
      const arm = plan.target.arms[plan.index]
      if (arm === undefined) return null
      const converted = plan.payload === null ? convertedValueText(plan.source, arm.value, text) : recordViewText(ctx, plan.payload, text)
      return converted === null ? null : `${cppTypeOf(plan.target)}::ofArm<${plan.index}>(${converted})`
    }
    case 'optional': {
      const built = recordViewText(ctx, plan.payload, plan.sourceOptional ? `(*${text})` : text)
      if (built === null) return null
      const optional = cppTypeOf(plan.target)
      if (!plan.sourceOptional) return `${optional}(${built})`
      return `(${text}.has_value() ? ${optional}(${built}) : ${optional}())`
    }
    case 'assert': {
      const built = recordViewText(ctx, plan.payload, `(*${text})`)
      if (built === null) return null
      // The language's own `!` is erased at runtime; a later member read of an
      // actually-absent value throws a TypeError, so the faithful C++ is a
      // CHECKED unwrap that throws too -- not a bare `*text`, which would be
      // undefined behaviour on absence. `gea::host::throwGetPropertyOfNullish`
      // is the same helper `emit-context.ts`/`emit-properties.ts` reach for a
      // nullish-base property read, and its `[[noreturn]] T` return lets it
      // stand as an expression of the target's own type in the ternary's other
      // arm.
      return `(${text}.has_value() ? ${built} : gea::host::throwGetPropertyOfNullish<${cppTypeOf(plan.target)}>())`
    }
    case 'recast-union': {
      const homes: RecastUnionHome[] = []
      for (const [index, home] of plan.arms.entries()) {
        const armText = recastUnionArmText(plan.source, text, index)
        const from = plan.source.arms[index]
        const into = plan.target.arms[home.index]
        if (from === undefined || into === undefined) return null
        const rendered =
          home.via === 'exact'
            ? armText
            : home.via === 'convert'
              ? convertedValueText(from.value, into.value, armText)
              : recordViewText(ctx, home.via, armText)
        if (rendered === null) return null
        homes.push({ index: home.index, text: rendered })
      }
      return recastedUnionFromHomes(plan.source, plan.target, text, homes)
    }
    case 'dispatch': {
      // The same discriminant chain `taggedUnionArmText` spells, with the last
      // arm untested: the plan admitted every arm, so one of them is live.
      // Each home is spelled at the whole target's type so an optional target
      // wraps once per arm and an absent arm is its empty state.
      const targetType = cppTypeOf(plan.target)
      const payload = plan.target.kind === 'optional' ? plan.target.payload : plan.target
      const homes: string[] = []
      for (const [index, arm] of plan.arms.entries()) {
        const from = plan.source.arms[index]
        if (from === undefined) return null
        const armText = `${text}.get<${index}>()`
        const rendered =
          arm.via === 'exact'
            ? armText
            : arm.via === 'absent'
              ? null
              : arm.via === 'convert'
                ? convertedValueText(from.value, payload, armText)
                : recordViewText(ctx, arm.via, armText)
        if (arm.via !== 'absent' && rendered === null) return null
        homes.push(rendered === null ? `${targetType}()` : `${targetType}(${rendered})`)
      }
      let result = homes[homes.length - 1]
      if (result === undefined) return null
      for (let index = homes.length - 2; index >= 0; index--) result = `${text}.is<${index}>() ? ${homes[index]} : (${result})`
      return `(${result})`
    }
    case 'fields':
      return recordFieldsViewText(ctx, plan, text)
  }
}

const recordFieldsViewText = (ctx: ConversionSite, plan: Extract<RecordViewPlan, { kind: 'fields' }>, text: string): string | null => {
  const { source, target } = plan
  // An `owned` record is a value, not a handle: its members are reached with
  // `.` where every refcounted carrier uses `->`.
  const arrow = (source.kind === 'record' || source.kind === 'record-with-index') && source.ownership !== 'shared-refcount' ? '.' : '->'
  const reads: string[] = []
  const presences: string[] = []
  const structName = cppRecordStructName(target.shapeId)
  for (const { field, read } of plan.fields) {
    if (read.kind === 'bound-method') {
      const bound = boundClassMethodText(ctx, source, field.value, field.key, text)
      if (bound === null) return null
      reads.push(bound)
      if (!field.required) presences.push('true')
      continue
    }
    if (read.kind === 'class-accessor') {
      const got = classAccessorReadText(ctx, source, field.value, field.key, read.value, text)
      if (got === null) return null
      reads.push(got)
      if (!field.required) presences.push('true')
      continue
    }
    if (read.kind === 'absent') {
      reads.push(`${cppTypeOf(field.value)}{}`)
      if (!field.required) presences.push('false')
      continue
    }
    const held = read.held
    const converted = convertedValueText(held.value, field.value, `${text}${arrow}${cppRecordFieldName(field.key)}`)
    if (converted === null) return null
    // Inside braces [dcl.init.list]/7 forbids the narrowing every other
    // position allows: a field the integer census holds in a `long long`
    // (`{ kind, type }` with `kind: 1 | 2`) is a hard error written into a
    // `double` member of the layout it is viewed as, though both carriers say
    // `scalar(number)`. `static_cast` spells the same conversion explicitly --
    // `emit-narrowing.ts`'s `recastFieldText` answers the identical rule this
    // way -- and is a no-op where the two already agree. The cast names the
    // member's OWN declared type, `decltype(Struct::member)`, because the
    // census's answer lives in the struct declaration `records.ts` emitted
    // and nowhere this emitter can ask: the representation says `double` for
    // both sides, and casting to that spelling is the same narrowing error
    // in the other direction whenever the TARGET member is the narrowed one
    // (a `Leaf { value: number }` read through a `Branch | Leaf` arm).
    const arithmetic = field.value.kind === 'scalar' && field.value.domain !== 'bigint'
    reads.push(
      arithmetic && held.value.kind === 'scalar'
        ? `static_cast<decltype(${structName}::${cppRecordFieldName(field.key)})>(${converted})`
        : converted
    )
    if (!field.required) {
      presences.push(held.required ? 'true' : `${text}${arrow}${cppRecordFieldPresenceName(field.key)}`)
    }
  }
  if (source.kind === 'record-with-index') {
    for (const { source: sourceIndex } of plan.indexes) {
      reads.push(`${text}${arrow}${cppRecordIndexSidecarNameFor(sourceIndex, source.indexes)}`)
      reads.push(`${text}${arrow}${cppRecordIndexAttributesNameFor(sourceIndex, source.indexes)}`)
    }
  }
  reads.push(...presences)
  const structure = `${structName}{${reads.join(', ')}}`
  if (target.ownership !== 'shared-refcount') return structure
  const allocated = `gea::makeRef<${structName}>(${structure})`
  if (plan.expando) return `gea::record::recastWithExpando(${allocated}, ${text}${arrow}${cppRecordIndexSidecarName})`
  // A class instance's view remembers the instance, so `instanceof` and a
  // narrowing back to the class still answer from it
  // (`gea::record::viewOrigin`, `projection/instance-test.ts`).
  if (source.kind === 'class-ref') {
    const boxed = dynamicCarrierBoxText(source, text)
    if (boxed === null) return null
    return `gea::record::rememberViewOrigin(${allocated}, ${boxed})`
  }
  return allocated
}
