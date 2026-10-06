import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type { CallableAbi, Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { structuralConversionKey, type CertifiedRecordViewPlan } from '../../conversion/structural-plan.js'
import {
  optionalMethodPayloadOf,
  restForwards,
  restPacks,
  structuralRecordViewPlan,
  type FamilyMemberKeys,
  type IteratorResultHome,
  type RecordViewPlan
} from '../../conversion/record-view.js'
import { classFamilyOverridesOf, virtualDispatchKey } from '../../projection/dispatch.js'
import { cppVirtualMemberName } from './virtual-methods.js'
import { classMemberOf } from './class-layout.js'
import { classMethodOverrideOf, classPrototypeMethodMutableOf } from '../../projection/fields.js'
import { cppThunkEntryText, cppThunkName } from './emit-context.js'
import {
  alignedValueText,
  chainConverts,
  namedConversionText,
  dynamicCarrierBoxText,
  recastedUnionFromHomes,
  recastUnionArmText,
  type ConversionSite,
  type RecastUnionHome
} from './emit-narrowing.js'
import { ownedRecordMaterializationText } from './emit-owned-record.js'
import {
  cppRecordIndexAttributesNameFor,
  cppRecordIndexSidecarNameFor,
  tailAwareFieldReadText,
  tailAwareFieldWriteText,
  tailFieldsOf
} from './records.js'
import { evaluatedOnceText } from './evaluated-once.js'
import {
  cppAbiParameterType,
  cppBodyName,
  cppCallableDeclarationTagName,
  cppClassName,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppStringLiteral,
  cppTypeOf,
  unitFunctionName
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

/**
 * `viewPlanFor`, planned knowing which interface family members the site
 * named (`nodes.ts`'s `familyMemberViewFor`). Cached per `members` object:
 * the census remembers each node, so the registry's existence check and the
 * printer's render of that node hand in the same one.
 */
const familyMemberViewPlans = new WeakMap<FamilyMemberKeys, Map<string, RecordViewPlan | null>>()

export const familyMemberViewPlanFor = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  members: FamilyMemberKeys
): RecordViewPlan | null => {
  let byPair = familyMemberViewPlans.get(members)
  if (byPair === undefined) {
    byPair = new Map()
    familyMemberViewPlans.set(members, byPair)
  }
  const key = `${representationKey(source)}->${representationKey(target)}`
  if (byPair.has(key)) return byPair.get(key) ?? null
  const plan = structuralRecordViewPlan(layouts, source, target, chainConverts, members)
  byPair.set(key, plan)
  return plan
}

/**
 * The structural plan of a pair when it homes EVERY arm of a source sum in
 * the target sum (`recastUnionPlan`), optionally under matching optionals --
 * the plan `emit-narrowing.ts`'s `recipeText` renders ahead of the chain
 * for a `view:structural-record` node. Any other plan (a
 * dispatch into one record, a single arm) is not a whole-sum recast.
 */
export const unionRecastPlanOf = (layouts: RecordLayoutPolicy, source: Representation, target: Representation): RecordViewPlan | null => {
  const plan = viewPlanFor(layouts, source, target)
  if (plan === null) return null
  if (plan.kind === 'recast-union') return plan
  return plan.kind === 'optional' && plan.sourceOptional && plan.payload.kind === 'recast-union' ? plan : null
}

/** The render of a `familyMemberViewFor` node: its plan, spelled exactly as `structuralRecordViewText` spells the pair's own. */
export const familyMemberViewText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  members: FamilyMemberKeys,
  text: string
): string | null => {
  const node = ctx.conversions.familyMemberViewFor(source, target, members)
  const materializer = node?.capability.kind === 'static' ? node.capability.materializer : null
  return materializer?.recordView === undefined ? null : certifiedRecordViewText(ctx, materializer.recordView, text)
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
  if (abi === null || abi.receiver !== null) return trace('member declares no plain callable abi')
  const site = classMemberOf(ctx.classes, source.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return trace('class has no callable method of that name')
  const own = site.method.representation
  if (!restForwards(abi, own !== undefined && 'abi' in own ? (own.abi as CallableAbi) : null))
    return trace("member's rest parameter is not the method's own packed rest")
  if (ctx.captures.of(site.method.callable).kind !== 'none') return trace('method captures, and the environment slot holds the receiver')
  const receiverType = cppTypeOf(source)
  const formals = abi.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} ${viewArgumentName(ordinal)}`)
  // A member frame wider than the method's own fixed frame -- a callback
  // overload joined into the member (`host-abi.ts`'s
  // `callbackOverloadJoinedAbi`) held by a class declaring only the promise
  // form -- passes the method its own prefix: JavaScript binds no formal to an
  // argument past the declared ones.
  const ownFrame = own !== undefined && 'abi' in own ? (own.abi as CallableAbi) : null
  const passed =
    ownFrame !== null && ownFrame.restFrom === null && abi.restFrom === null && ownFrame.parameters.length < abi.parameters.length
      ? ownFrame.parameters.length
      : abi.parameters.length
  const actuals = abi.parameters.slice(0, passed).map((_, ordinal) => viewArgumentName(ordinal))
  // The fixed prefix ahead of a rest position is the METHOD's own formal, which
  // may be wider than the member's (`event: string | symbol` behind a
  // `'stateChanged'` literal, or a stream-like interface's `emit(name: string,
  // ...)` field bound to `EventEmitter.emit(name: EventName, ...)` once the
  // concrete class declares no override of its own and the bind falls through
  // to the ancestor). Shared by both shapes below: `restPacks`' fully-fixed
  // member and `restForwards`' own already-packed member differ only in what
  // happens AT the rest position, never in whether the prefix before it needs
  // converting.
  const widenFixedPrefix = (restFrom: number): string | null => {
    for (let ordinal = 0; ordinal < restFrom; ordinal++) {
      const held = abi.parameters[ordinal]?.value
      const formal = ownFrame?.parameters[ordinal]?.value
      if (held === undefined || formal === undefined || cppTypeOf(held) === cppTypeOf(formal)) continue
      const converted = alignedValueText(ctx, 'emit-record-view.ts:widenFixedPrefix', held, formal, viewArgumentName(ordinal))
      if (converted === null) return `member argument ${ordinal} does not enter the method's formal`
      actuals[ordinal] = converted
    }
    return null
  }
  // The method packs its rest where the member declares fixed parameters
  // (`restPacks`): the member's arguments from the rest position on become
  // the method's one Array, each entered into its element carrier.
  if (ownFrame !== null && restPacks(abi, ownFrame)) {
    const restFrom = ownFrame.restFrom as number
    const rest = ownFrame.parameters[restFrom]?.value
    if (rest === undefined || rest.kind !== 'array-object') return trace("method's rest is not an Array")
    const elementType = cppTypeOf(rest.element)
    const elements: string[] = []
    for (const [offset, parameter] of abi.parameters.slice(restFrom).entries()) {
      const formal = viewArgumentName(restFrom + offset)
      const element =
        cppTypeOf(parameter.value) === elementType
          ? formal
          : alignedValueText(ctx, 'emit-record-view.ts:restPack', parameter.value, rest.element, formal)
      if (element === null) return trace(`member argument ${restFrom + offset} does not enter the method's rest element`)
      elements.push(element)
    }
    actuals.splice(restFrom, actuals.length - restFrom, `gea::arrayOf<${elementType}>({${elements.join(', ')}})`)
    const refused = widenFixedPrefix(restFrom)
    if (refused !== null) return trace(refused)
  } else if (ownFrame !== null && ownFrame.restFrom !== null && abi.restFrom === ownFrame.restFrom) {
    // `restForwards` proved the two rest slots agree on their ELEMENT carrier;
    // it says nothing about the fixed positions ahead of it, which the member
    // and the method may still name with different (but convertible) types.
    const refused = widenFixedPrefix(ownFrame.restFrom)
    if (refused !== null) return trace(refused)
  } else if (ownFrame !== null && ownFrame.restFrom === null && abi.restFrom === null) {
    // Fixed signatures need the same carrier conversion as the prefix of a
    // rest signature. An interface can pass one record into a method whose
    // complete caller census places that argument in a native union.
    const refused = widenFixedPrefix(passed)
    if (refused !== null) return trace(refused)
  }
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
 * A class METHOD as a member whose convention keeps the receiver a formal:
 * the prototype's own function object, the value `instance.method` reads.
 *
 * mongodb's `createStdioLogger(process.stderr)` declares its parameter
 * `{ write: NodeJS.WriteStream['write'] }` -- the method's TYPE, receiver
 * included -- so the member is not a bound closure but the unbound method,
 * and a call through the view supplies `this` from the view's origin. The
 * value is minted through `gea::nativeClassMethodValue`, the same identity
 * cache a plain `instance.method` read uses (`emit-class-properties.ts`), so
 * `view.write === stream.write` holds.
 *
 * Refused where naming the resolved body is not the method the instance
 * answers with: a subclass that overrides the key, an own-property shadow a
 * class body stores, a prototype the program replaces, or a body with
 * captures whose environment this expression cannot build.
 */
const classMethodValueViewText = (
  ctx: ConversionSite,
  source: Representation,
  member: Representation,
  key: string,
  text: string
): string | null => {
  if (source.kind !== 'class-ref') return null
  const site = classMemberOf(ctx.classes, source.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
  if (classFamilyOverridesOf(ctx.classes, source.declaration, key).length > 0) return null
  if (classMethodOverrideOf(ctx.classes, source.declaration, key) !== null) return null
  if (classPrototypeMethodMutableOf(ctx.classes, source.declaration, key)) return null
  if (ctx.captures.of(site.method.callable).kind !== 'none') return null
  const own = site.method.representation
  if (own === undefined || own.kind !== 'function-value-dispatch') return null
  const callable = site.method.callable
  const entry =
    ctx.functionFacts === undefined ? `&${cppThunkName(callable)}` : cppThunkEntryText({ functionFacts: ctx.functionFacts }, callable)
  const value =
    `gea::nativeClassMethodValue<${cppClassName(site.owner)}, &${cppCallableDeclarationTagName(callable)}>` +
    `(${text}->gea_method_state, ${cppTypeOf(own)}{${entry}, nullptr})`
  return alignedValueText(ctx, 'emit-record-view.ts:classMethodValueViewText', own, member, value)
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
  const node = ctx.conversions.nodeFor(source, target)
  const materializer = node.capability.kind === 'static' || node.capability.kind === 'atom' ? node.capability.materializer : null
  return materializer?.recordView === undefined ? null : certifiedRecordViewText(ctx, materializer.recordView, text)
}

interface RecordViewSite extends ConversionSite {
  readonly structuralConversions: ReadonlyMap<string, ConversionNode>
}

const structuralLeafText = (ctx: RecordViewSite, source: Representation, target: Representation, text: string): string | null => {
  const node = ctx.structuralConversions.get(structuralConversionKey(source, target))
  if (node === undefined) throw new Error(`record view has no certified leaf for ${structuralConversionKey(source, target)}`)
  return namedConversionText(ctx, 'emit-record-view.ts:certified-leaf', node, text)
}

export const certifiedRecordViewText = (ctx: ConversionSite, plan: CertifiedRecordViewPlan, text: string): string | null => {
  const viewCtx: RecordViewSite = {
    ...ctx,
    structuralConversions: plan.leaves,
    conversions: {
      ...ctx.conversions,
      nodeFor: (source, target) => {
        const node = plan.leaves.get(structuralConversionKey(source, target))
        if (node === undefined) throw new Error(`record view has no certified leaf for ${structuralConversionKey(source, target)}`)
        return node
      }
    }
  }
  return evaluatedOnceText(text, (operand) => recordViewText(viewCtx, plan.view, operand))
}

const recordViewText = (ctx: RecordViewSite, plan: RecordViewPlan, text: string): string | null => {
  switch (plan.kind) {
    case 'owned':
      return ownedRecordMaterializationText(plan.plan, text)
    case 'arm': {
      const arm = plan.target.arms[plan.index]
      if (arm === undefined) return null
      const converted =
        plan.payload === null ? structuralLeafText(ctx, plan.source, arm.value, text) : recordViewText(ctx, plan.payload, text)
      return converted === null ? null : `${cppTypeOf(plan.target)}::ofArm<${plan.index}>(${converted})`
    }
    case 'optional': {
      const built = recordViewText(ctx, plan.payload, plan.sourceOptional ? `(*${text})` : text)
      if (built === null) return null
      const optional = cppTypeOf(plan.target)
      if (plan.sourceNullableReference) return `(${text} ? ${optional}(${built}) : ${optional}())`
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
              ? structuralLeafText(ctx, from.value, into.value, armText)
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
                ? structuralLeafText(ctx, from.value, payload, armText)
                : recordViewText(ctx, arm.via, armText)
        if (arm.via !== 'absent' && rendered === null) return null
        homes.push(rendered === null ? `${targetType}()` : `${targetType}(${rendered})`)
      }
      let result = homes[homes.length - 1]
      if (result === undefined) return null
      for (let index = homes.length - 2; index >= 0; index--) result = `${text}.is<${index}>() ? ${homes[index]} : (${result})`
      return `(${result})`
    }
    case 'iterator-result': {
      const source = 'gea_iterator_result'
      const targetType = cppTypeOf(plan.target)
      const home = (planned: IteratorResultHome): string | null => {
        const arm = plan.target.arms[planned.index]
        if (arm === undefined) return null
        const built =
          planned.payload === null
            ? alignedValueText(ctx, 'emit-record-view.ts:iterator-result', plan.source, arm.value, source)
            : recordViewText(ctx, planned.payload, source)
        return built === null ? null : `${targetType}::ofArm<${planned.index}>(${built})`
      }
      const returned = home(plan.returnHome)
      const yielded = home(plan.yieldHome)
      if (returned === null || yielded === null) return null
      // An `owned` record is a value, not a handle, exactly as `recordFieldsViewText` reads one.
      const arrow =
        (plan.source.kind === 'record' || plan.source.kind === 'record-with-index') && plan.source.ownership !== 'shared-refcount'
          ? '.'
          : '->'
      return (
        `([&]() -> ${targetType} { const auto& ${source} = ${text}; ` +
        `return ${source}${arrow}${cppRecordFieldName('done')} ? ${returned} : ${yielded}; }())`
      )
    }
    case 'fields':
      return recordFieldsViewText(ctx, plan, text)
  }
}

/** The cell holding a record view's one sidecar lookup; see `recordViewText`. */
const sidecarExpandoCell = 'gea_sidecar_expando'

/**
 * A view built field by field depends on nothing at its site but the source it
 * reads, so a unit defines it once over a formal and every site calls it
 * (`unitFunctionName`). mongodb rebuilds its 131-field options record out of
 * the same source carrier at dozens of call arguments; pasted, each copy was
 * the whole field list.
 */
const recordFieldsViewText = (ctx: RecordViewSite, plan: Extract<RecordViewPlan, { kind: 'fields' }>, text: string): string | null => {
  const formal = 'gea_view_source'
  const body = recordFieldsViewTextAt(ctx, plan, formal)
  if (body === null) return null
  const named = unitFunctionName(
    `gea_view_${cppRecordStructName(plan.target.shapeId)}`,
    (name) => `${cppTypeOf(plan.target)} ${name}(const ${cppTypeOf(plan.source)}& ${formal})`,
    `return ${body};`
  )
  return named === null ? recordFieldsViewTextAt(ctx, plan, text) : `${named}(${text})`
}

const recordFieldsViewTextAt = (ctx: RecordViewSite, plan: Extract<RecordViewPlan, { kind: 'fields' }>, text: string): string | null => {
  const sidecarCells: string[] = []
  const built = recordFieldsBuiltText(ctx, plan, text, sidecarCells)
  if (built === null || sidecarCells.length === 0) return built
  // The source's identity-keyed sidecar, looked up once for every added key
  // the view reads from it (`gea::detail::nativeSidecarGet`); `null` when the
  // record never grew one. `sidecarExpandoCell` marks the lookup; the cells
  // follow it.
  const cells = sidecarCells.map((cell) =>
    cell === sidecarExpandoCell
      ? `const gea::Ref<gea::DynamicObject> ${cell} = gea::detail::expandoFor(gea::refCastToVoid(${text}), false);`
      : `gea::Value ${cell};`
  )
  if (!sidecarCells.includes(sidecarExpandoCell)) return `([&]() { ${cells.join(' ')} return ${built}; }())`
  // A record that never grew a sidecar -- the common case: a typed options
  // record the program only ever wrote through its declared fields -- holds
  // none of the added keys, so the view is built from the declared fields
  // alone. Without this branch every added key was still a `PropertyKey`, a
  // `nativeSidecarGet` and a `gea::Value` per view: mongodb's 134-field
  // options record read 110 of them from an empty sidecar, twice per
  // operation.
  // Index-sidecar reads still number their cells from this list, so it
  // starts past the expando cell and any cell only this build names is
  // declared beside the others.
  const absentCells: string[] = [sidecarExpandoCell]
  const absent = recordFieldsBuiltText(ctx, plan, text, absentCells, true)
  if (absent === null) return null
  // The expando-free build reads no sidecar cell but an index one, so only
  // those are declared ahead of the branch it returns from; the cells the
  // full build alone names follow the branch. Declared before it, every one
  // of them was constructed and destroyed on the path that never read it --
  // 134 `gea::Value`s per view of mongodb's options family, twice an
  // operation, for a sidecar the record did not have.
  const shared = absentCells.filter((cell) => cell !== sidecarExpandoCell)
  const before = cells.filter(
    (cell) => cell.startsWith('const gea::Ref<gea::DynamicObject>') || shared.some((name) => cell === `gea::Value ${name};`)
  )
  const after = cells.filter((cell) => !before.includes(cell))
  const extra = shared.filter((cell) => !sidecarCells.includes(cell)).map((cell) => `gea::Value ${cell};`)
  // The full build is out of line and cold: it is most of the view's code
  // (a lookup, a `PropertyKey` and a `gea::Value` per added key -- 110 of
  // them for mongodb's options family, ~60 KB of machine code per view) and
  // the rare case, and inlined beside the expando-free build it spread every
  // view's hot path across the instruction cache.
  return `([&]() { ${[...before, ...extra].join(' ')} if (!${sidecarExpandoCell}) return ${absent}; return ([&]() __attribute__((noinline, cold)) { ${after.join(' ')} return ${built}; }()); }())`
}

const recordFieldsBuiltText = (
  ctx: RecordViewSite,
  plan: Extract<RecordViewPlan, { kind: 'fields' }>,
  text: string,
  sidecarCells: string[],
  // The source has no expando sidecar (`recordFieldsViewTextAt`'s null
  // branch): every key read from one is absent. Index-sidecar reads are
  // unaffected; those are a field of the source, not its expando.
  expandoAbsent = false
): string | null => {
  const { source, target } = plan
  // An `owned` record is a value, not a handle: its members are reached with
  // `.` where every refcounted carrier uses `->`.
  const arrow = (source.kind === 'record' || source.kind === 'record-with-index') && source.ownership !== 'shared-refcount' ? '.' : '->'
  const reads: string[] = []
  // Presence bits are ASSIGNED after the build, never initialized by
  // position: `records.ts` lays out one bit per field, required ones
  // included, unless the program-wide census made the required bits `static`
  // -- so a positional list of the OPTIONAL bits lands each on a required one
  // whenever that census says no (see `emit-narrowing.ts`'s
  // `recastedRecordText`). Left alone a bit keeps its declared default.
  const presences: (readonly [string, string])[] = []
  const structName = cppRecordStructName(target.shapeId)
  // A source or target whose layout moved fields behind its `RecordTail`
  // (records.ts's `tailFieldsOf`) is read through the tail's non-allocating
  // spelling and, as a target, filled by name rather than by position.
  const sourceFields =
    source.kind === 'record' || source.kind === 'record-with-index'
      ? source.fields
      : source.kind === 'native-record-ref' && source.native === null
        ? ctx.layouts.forShape(source.shapeId)
        : null
  const heldTextOf = (key: string): string =>
    sourceFields === null ? `${text}${arrow}${cppRecordFieldName(key)}` : tailAwareFieldReadText(sourceFields, key, `${text}${arrow}`)
  const targetFields = target.kind === 'record' ? target.fields : ctx.layouts.forShape(target.shapeId)
  const targetTailed = targetFields !== null && tailFieldsOf({ fields: targetFields }).size > 0
  let orderSensitive = false
  for (const { field, read } of plan.fields) {
    // An optional method member is bound as its present payload, then held
    // by the optional (`optionalMethodPayloadOf`).
    const method = optionalMethodPayloadOf(field.value)
    const present = (bound: string): string => (method === field.value ? bound : `${cppTypeOf(field.value)}(${bound})`)
    if (read.kind === 'bound-method') {
      const bound = boundClassMethodText(ctx, source, method, field.key, text)
      if (bound === null) return null
      reads.push(present(bound))
      if (!field.required) presences.push([field.key, 'true'])
      continue
    }
    if (read.kind === 'method-value') {
      const value = classMethodValueViewText(ctx, source, method, field.key, text)
      if (value === null) return null
      reads.push(present(value))
      if (!field.required) presences.push([field.key, 'true'])
      continue
    }
    if (read.kind === 'class-accessor') {
      const got = classAccessorReadText(ctx, source, field.value, field.key, read.value, text)
      if (got === null) return null
      orderSensitive = true
      reads.push(got)
      if (!field.required) presences.push([field.key, 'true'])
      continue
    }
    if (read.kind === 'absent') {
      reads.push(`${cppTypeOf(field.value)}{}`)
      if (!field.required) presences.push([field.key, 'false'])
      continue
    }
    if (read.kind === 'sidecar') {
      const fromIndex = read.from === 'index' && source.kind === 'record-with-index'
      if (expandoAbsent && !fromIndex) {
        reads.push(`${cppTypeOf(field.value)}{}`)
        if (!field.required) presences.push([field.key, 'false'])
        continue
      }
      // The key's value, or `undefined` when the sidecar lacks it: an absent
      // key and an explicit `undefined` both read back as the optional's absence.
      orderSensitive = true
      if (!fromIndex && !sidecarCells.includes(sidecarExpandoCell)) sidecarCells.unshift(sidecarExpandoCell)
      const got = fromIndex
        ? `${text}${arrow}${cppRecordIndexSidecarNameFor(source.indexes[0]!, source.indexes)}.read(${cppStringLiteral(field.key)})`
        : `gea::nativeSidecarGetText(${text}, ${sidecarExpandoCell}, ${cppStringLiteral(field.key)})`
      const fieldType = cppTypeOf(field.value)
      const sidecarValue: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
      const converted = alignedValueText(ctx, 'emit-record-view.ts:sidecar-field', sidecarValue, field.value, 'gea_sidecar')
      if (converted === null) return null
      const returned = `return gea_sidecar.tag() == gea::Value::Tag::Undefined ? ${fieldType}{} : ${fieldType}(${converted});`
      // The absent-or-converted read depends on the field's carrier alone, so
      // it is one unit function per carrier, called with the sidecar's value.
      const sidecarRead = unitFunctionName('gea_sidecar_field', (name) => `${fieldType} ${name}(const gea::Value& gea_sidecar)`, returned)
      if (field.required) {
        reads.push(
          sidecarRead === null
            ? `([&]() -> ${fieldType} { const gea::Value gea_sidecar = ${got}; ${returned} }())`
            : `${sidecarRead}(${got})`
        )
        continue
      }
      // The presence flag answers from the SAME read as the value: a sidecar
      // key is a `[[Get]]` that may run an accessor, and reading it again for
      // the flag ran it twice. Braced initialization evaluates in order
      // ([dcl.init.list]/4), so every value's read has landed in its cell
      // before the first flag is initialized.
      const cell = `gea_sidecar_read_${sidecarCells.length}`
      sidecarCells.push(cell)
      reads.push(
        sidecarRead === null
          ? `([&]() -> ${fieldType} { ${cell} = ${got}; const gea::Value& gea_sidecar = ${cell}; ${returned} }())`
          : `${sidecarRead}(${cell} = ${got})`
      )
      presences.push([field.key, `(${cell}.tag() != gea::Value::Tag::Undefined)`])
      continue
    }
    const held = read.held
    const heldText = heldTextOf(field.key)
    const converted =
      read.kind === 'view' ? recordViewText(ctx, read.plan, heldText) : structuralLeafText(ctx, held.value, field.value, heldText)
    if (converted === null) return null
    // A nested view is order-sensitive exactly when its own reads are: a
    // getter body, a virtual accessor or a sidecar `[[Get]]` inside it.
    if (read.kind === 'view' && ['gea_sidecar', 'gea_vget_', 'gea_body_fn_decl_'].some((mark) => converted.includes(mark))) {
      orderSensitive = true
    }
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
      presences.push([field.key, held.required ? 'true' : `${text}${arrow}${cppRecordFieldPresenceName(field.key)}`])
    }
  }
  if (source.kind === 'record-with-index') {
    for (const { source: sourceIndex } of plan.indexes) {
      reads.push(`${text}${arrow}${cppRecordIndexSidecarNameFor(sourceIndex, source.indexes)}`)
      reads.push(`${text}${arrow}${cppRecordIndexAttributesNameFor(sourceIndex, source.indexes)}`)
    }
  }
  const built = `${structName}{${reads.join(', ')}}`
  const targetArrow = target.ownership === 'shared-refcount' ? '->' : '.'
  const spills: string[] = presences
    .filter(([, present]) => present !== 'false')
    .map(([key, present]) => `gea_view${targetArrow}${cppRecordFieldPresenceName(key)} = ${present};`)
  // A named source field the target does not declare lands in the target's
  // string index (`RecordViewPlan.spilled`), after the struct is built.
  for (const { held, index } of plan.spilled ?? []) {
    const heldText = heldTextOf(held.key)
    const converted = alignedValueText(ctx, 'emit-record-view.ts:index-spill', held.value, index.value, heldText)
    if (converted === null) return null
    const store = `gea_view${targetArrow}${cppRecordIndexSidecarNameFor(index, [index])}[${cppStringLiteral(held.key)}] = ${converted};`
    spills.push(held.required ? store : `if (${text}${arrow}${cppRecordFieldPresenceName(held.key)}) ${store}`)
  }
  const spilledInto = (value: string): string =>
    spills.length === 0 ? value : `([&]() { auto gea_view = ${value}; ${spills.join(' ')} return gea_view; }())`
  if (targetTailed) {
    // Filled by name, present fields only: an absent one stored through the
    // tail's write spelling would allocate the block for nothing. A presence
    // that is a runtime test reads the value first, because a sidecar read
    // is what sets the cell that test inspects.
    const presenceOf = new Map(presences)
    const stores = plan.fields.map(({ field }, index) => {
      const member = `gea_view${targetArrow}${tailAwareFieldWriteText(targetFields!, field.key)}`
      if (field.required) return `${member} = ${reads[index]!};`
      const present = presenceOf.get(field.key) ?? 'false'
      if (present === 'false') return ''
      const flag = `gea_view${targetArrow}${cppRecordFieldPresenceName(field.key)} = true;`
      if (present === 'true') return `${member} = ${reads[index]!}; ${flag}`
      return `{ auto gea_field = ${reads[index]!}; if (${present}) { ${member} = std::move(gea_field); ${flag} } }`
    })
    if (source.kind === 'record-with-index') {
      const targetIndexes = plan.indexes.map(({ target: targetIndex }) => targetIndex)
      for (const { source: sourceIndex, target: targetIndex } of plan.indexes) {
        const from = `${text}${arrow}`
        stores.push(
          `gea_view${targetArrow}${cppRecordIndexSidecarNameFor(targetIndex, targetIndexes)} = ${from}${cppRecordIndexSidecarNameFor(sourceIndex, source.indexes)};`,
          `gea_view${targetArrow}${cppRecordIndexAttributesNameFor(targetIndex, targetIndexes)} = ${from}${cppRecordIndexAttributesNameFor(sourceIndex, source.indexes)};`
        )
      }
    }
    const indexSpills = spills.slice(presences.filter(([, present]) => present !== 'false').length)
    const declared = target.ownership === 'shared-refcount' ? `auto gea_view = gea::makeRef<${structName}>();` : `${structName} gea_view{};`
    const filled = `([&]() { ${declared} ${[...stores, ...indexSpills].filter((line) => line !== '').join(' ')} return gea_view; }())`
    if (target.ownership !== 'shared-refcount') return filled
    return recordViewFinished(ctx, plan, text, arrow, filled)
  }
  const structure = spilledInto(built)
  if (target.ownership !== 'shared-refcount') return structure
  // Built in the block itself (C++20 parenthesized aggregate initialization)
  // rather than as a stack temporary the block is then move-constructed from
  // and that is destroyed field by field afterwards: 2.4 KB of stack, a
  // 134-field move and a 134-field destructor per view of mongodb's options
  // family. A call's arguments are evaluated in no fixed order, though, so a
  // build with an observable read -- an accessor, a sidecar `[[Get]]` -- keeps
  // the braces, whose [dcl.init.list]/4 order is the property order.
  const allocated = spilledInto(
    orderSensitive ? `gea::makeRef<${structName}>(${built})` : `gea::makeRef<${structName}>(${reads.join(', ')})`
  )
  return recordViewFinished(ctx, plan, text, arrow, allocated)
}

/**
 * What a built view still owes once its block is allocated: the open keys of
 * an indexed source, or the class instance it was viewed from.
 */
const recordViewFinished = (
  ctx: ConversionSite,
  plan: Extract<RecordViewPlan, { kind: 'fields' }>,
  text: string,
  arrow: string,
  allocated: string
): string | null => {
  const { source, target } = plan
  if (plan.expando && source.kind === 'record-with-index') {
    // The keys the target names were read into its fields above; the rest of
    // the open document, and any named field the target lacks, stay own
    // properties of the view.
    const named = target.kind === 'record' ? target.fields : (ctx.layouts.forShape(target.shapeId) ?? [])
    const excluded = named.map((field) => cppStringLiteral(field.key)).join(', ')
    const extras: string[] = []
    for (const held of plan.expandoSpilled ?? []) {
      const heldText = tailAwareFieldReadText(source.fields, held.key, `${text}${arrow}`)
      const boxed = alignedValueText(
        ctx,
        'emit-record-view.ts:expando-spill',
        held.value,
        { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
        heldText
      )
      if (boxed === null) return null
      const store = `gea::nativeDynamicSet(gea_view, gea::PropertyKey::string(${cppStringLiteral(held.key)}), ${boxed});`
      extras.push(held.required ? store : `if (${text}${arrow}${cppRecordFieldPresenceName(held.key)}) ${store}`)
    }
    const sidecar = `${text}${arrow}${cppRecordIndexSidecarNameFor(source.indexes[0]!, source.indexes)}`
    return (
      `([&]() { auto gea_view = gea::record::assignDynamicPropertiesExcept(${allocated}, ${sidecar}, {${excluded}}); ` +
      `${extras.join(' ')} return gea_view; }())`
    )
  }
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
