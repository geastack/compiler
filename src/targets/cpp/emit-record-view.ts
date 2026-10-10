import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type { Representation } from '../../representation/model.js'
import { carriesNativeUndefined, representationKey } from '../../representation/model.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { structuralConversionKey, type CertifiedRecordViewPlan, type StructuralMethodRecipe } from '../../conversion/structural-plan.js'
import { recipeClosureOf } from '../../conversion/recipe-closure.js'
import { nativeClassMethodReadText } from './class-properties/native-method-read.js'
import { liveFieldViewText, type LiveFieldViewAccess } from './emit-live-field-view.js'
import { nativeFieldViewPlanIsLive, type NativeFieldViewPlan } from '../../conversion/native-field-view.js'
import type { FunctionId } from '../../identity/ids.js'
import { storedEnvironmentText } from './emit-context.js'
import {
  optionalMethodPayloadOf,
  structuralRecordViewPlan,
  type FamilyMemberKeys,
  type IteratorResultHome,
  type RecordViewPlan
} from '../../conversion/record-view.js'
import { classFamilyOverridesOf, virtualDispatchKey } from '../../projection/dispatch.js'
import { cppVirtualMemberName } from './virtual-methods.js'
import { classMemberOf } from './class-layout.js'
import {
  alignedValueText,
  chainConverts,
  namedConversionText,
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
  cppBodyName,
  cppRecordFieldName,
  cppRecordAccessorEnvironmentName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
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
 * views and how each field is reached; this spells its exact certified leaves.
 * A captured method requires this site's lexical environment renderer; a site
 * that cannot name that environment refuses the method read.
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
  readonly structuralMethods: readonly StructuralMethodRecipe[]
  readonly nativeFieldViews: ReadonlyMap<RecordViewPlan, NativeFieldViewPlan>
}

const structuralLeafText = (ctx: RecordViewSite, source: Representation, target: Representation, text: string): string | null => {
  const node = ctx.structuralConversions.get(structuralConversionKey(source, target))
  if (node === undefined) throw new Error(`record view has no certified leaf for ${structuralConversionKey(source, target)}`)
  return namedConversionText(ctx, 'emit-record-view.ts:certified-leaf', node, text)
}

export const certifiedRecordViewText = (ctx: ConversionSite, plan: CertifiedRecordViewPlan, text: string): string | null => {
  const closure = recipeClosureOf(plan.leaves.values(), ctx.conversions?.nodeById)
  const viewCtx: RecordViewSite = {
    ...ctx,
    structuralConversions: plan.leaves,
    structuralMethods: plan.methods,
    nativeFieldViews: nativeFieldViewPlanIsLive(plan) ? plan.fieldViews! : new Map(),
    conversions: {
      ...ctx.conversions,
      nodeById: (id) => closure.get(id) ?? null,
      nodeFor: (source, target) => {
        const node = plan.leaves.get(structuralConversionKey(source, target))
        if (node === undefined) throw new Error(`record view has no certified leaf for ${structuralConversionKey(source, target)}`)
        return node
      }
    }
  }
  return evaluatedOnceText(text, (operand) => {
    const built = recordViewText(viewCtx, plan.view, operand)
    if (built === null || !carriesNativeUndefined(plan.source) || !carriesNativeUndefined(plan.target)) return built
    const targetType = cppTypeOf(plan.target)
    return `(${operand}.isUndefined() ? ${targetType}::undefined() : ${operand} ? ${built} : ${targetType}())`
  })
}

const recordViewText = (ctx: RecordViewSite, plan: RecordViewPlan, text: string): string | null => {
  switch (plan.kind) {
    case 'owned':
      return ownedRecordMaterializationText(plan.plan, text)
    case 'arm': {
      const arm = plan.target.arms[plan.index]
      if (arm === undefined) return null
      const present = plan.absentIndex === undefined ? text : `(*${text})`
      const converted =
        plan.payload === null ? structuralLeafText(ctx, plan.source, arm.value, present) : recordViewText(ctx, plan.payload, present)
      if (converted === null) return null
      const union = cppTypeOf(plan.target)
      if (plan.absentIndex === undefined) return `${union}::ofArm<${plan.index}>(${converted})`
      return `(${text}.has_value() ? ${union}::ofArm<${plan.index}>(${converted}) : ${union}::ofArm<${plan.absentIndex}>(${union}::ArmType<${plan.absentIndex}>{}))`
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
 * (`unitFunctionName`). A program can rebuild a 131-field options record out
 * of the same source carrier at dozens of call arguments; pasted, each copy
 * was the whole field list.
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
  // `nativeSidecarGet` and a `gea::Value` per view: a 134-field
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
  // 134 `gea::Value`s per view of a 134-field options family, twice an
  // operation, for a sidecar the record did not have.
  const shared = absentCells.filter((cell) => cell !== sidecarExpandoCell)
  const before = cells.filter(
    (cell) => cell.startsWith('const gea::Ref<gea::DynamicObject>') || shared.some((name) => cell === `gea::Value ${name};`)
  )
  const after = cells.filter((cell) => !before.includes(cell))
  const extra = shared.filter((cell) => !sidecarCells.includes(cell)).map((cell) => `gea::Value ${cell};`)
  // The full build is out of line and cold: it is most of the view's code
  // (a lookup, a `PropertyKey` and a `gea::Value` per added key -- 110 of
  // them for a 134-field options family, ~60 KB of machine code per view) and
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
  const live = ctx.nativeFieldViews.get(plan)
  if (live) return liveRecordFieldsText(ctx, plan, live, text)
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
  // An authenticated source allocation is a traced edge of the new view's
  // own allocation. Value-record copies have no source handle to retain.
  const allocate = (argumentsText: string): string =>
    source.ownership === 'shared-refcount'
      ? `gea::record::makeViewWithOrigin<${structName}>(${text}${argumentsText === '' ? '' : `, ${argumentsText}`})`
      : `gea::makeRef<${structName}>(${argumentsText})`
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
    // An optional method member uses its present callable payload, then the
    // optional wraps it (`optionalMethodPayloadOf`).
    const method = optionalMethodPayloadOf(field.value)
    const present = (bound: string): string => (method === field.value ? bound : `${cppTypeOf(field.value)}(${bound})`)
    if (read.kind === 'bound-method') {
      if (source.kind !== 'class-ref') return null
      const recipe = ctx.structuralMethods.find(
        (candidate) =>
          candidate.declaration === source.declaration &&
          candidate.key === field.key &&
          representationKey(candidate.target) === representationKey(method)
      )
      if (recipe === undefined) throw new Error(`record view method ${field.key} has no certified native read`)
      const callable = nativeClassMethodReadText(ctx, source, recipe.source, field.key, text, (_site, from, into, value) =>
        structuralLeafText(ctx, from, into, value)
      )
      if (callable === null) return null
      const unbound = namedConversionText(ctx, 'emit-record-view.ts:native-method', recipe.method, callable)
      if (unbound === null) return null
      const adapted = namedConversionText(ctx, 'emit-record-view.ts:method-frame', recipe.adaptation, unbound)
      if (adapted === null) return null
      reads.push(present(adapted))
      if (!field.required) presences.push([field.key, 'true'])
      continue
    }
    if (read.kind === 'method-value') {
      if (source.kind !== 'class-ref') return null
      const value = nativeClassMethodReadText(ctx, source, method, field.key, text, (_site, from, into, value) =>
        structuralLeafText(ctx, from, into, value)
      )
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
    if (read.kind === 'record-accessor') {
      const argumentsOf =
        ctx.captures.of(read.getter).kind === 'ok'
          ? [storedEnvironmentText(read.getter, `${text}${arrow}${cppRecordAccessorEnvironmentName(field.key, 'getter')}`), text]
          : [text]
      const got = `${cppBodyName(read.getter)}(${argumentsOf.join(', ')})`
      const converted = structuralLeafText(ctx, read.value, field.value, got)
      if (converted === null) return null
      reads.push(converted)
      orderSensitive = true
      if (!field.required) presences.push([field.key, 'true'])
      continue
    }
    if (read.kind === 'absent') {
      reads.push(`${cppTypeOf(field.value)}{}`)
      if (!field.required) presences.push([field.key, 'false'])
      continue
    }
    if (read.kind === 'native-descriptor') return null
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
    const declared = target.ownership === 'shared-refcount' ? `auto gea_view = ${allocate('')};` : `${structName} gea_view{};`
    const filled = `([&]() { ${declared} ${[...stores, ...indexSpills].filter((line) => line !== '').join(' ')} return gea_view; }())`
    if (target.ownership !== 'shared-refcount') return filled
    return recordViewFinished(ctx, plan, text, arrow, filled)
  }
  const structure = spilledInto(built)
  if (target.ownership !== 'shared-refcount') return structure
  // Built in the block itself (C++20 parenthesized aggregate initialization)
  // rather than as a stack temporary the block is then move-constructed from
  // and that is destroyed field by field afterwards: 2.4 KB of stack, a
  // 134-field move and a 134-field destructor per view of a large options
  // family. A call's arguments are evaluated in no fixed order, though, so a
  // build with an observable read -- an accessor, a sidecar `[[Get]]` -- keeps
  // the braces, whose [dcl.init.list]/4 order is the property order.
  const allocated = spilledInto(allocate(orderSensitive ? built : reads.join(', ')))
  return recordViewFinished(ctx, plan, text, arrow, allocated)
}

const liveRecordFieldsText = (
  ctx: RecordViewSite,
  plan: Extract<RecordViewPlan, { kind: 'fields' }>,
  live: NativeFieldViewPlan,
  text: string
): string | null => {
  const source = plan.source
  const actual = 'gea_live_source'
  const environment = (key: string, body: FunctionId, half: 'getter' | 'setter'): readonly string[] =>
    ctx.captures.of(body).kind === 'ok' ? [storedEnvironmentText(body, `${actual}->${cppRecordAccessorEnvironmentName(key, half)}`)] : []
  const accesses: LiveFieldViewAccess[] = []
  for (const { field, read } of plan.fields) {
    const route = live.fields.find((entry) => entry.key === field.key)
    if (!route) throw new Error(`a live view has no route for ${field.key}`)
    if (read.kind === 'native-descriptor') {
      accesses.push({ key: field.key, read: null, write: null, descriptorForward: true })
      continue
    }
    let got: string | null = null
    let write: LiveFieldViewAccess['write'] = null
    if (read.kind === 'held' || read.kind === 'view') {
      const type = cppTypeOf(route.read)
      const absence =
        !read.held.required && route.read.kind === 'optional' && route.read.absence === 'undefined'
          ? `bool gea_origin_present = false; if (!${actual}->gea_ownFieldPresent(gea_key, gea_origin_present)) ` +
            'gea::host::throwRuntimeError("TypeError", "a live native field has no source presence protocol"); ' +
            `if (!gea_origin_present) return ${type}{}; `
          : ''
      got =
        `([&]() -> ${type} { ${absence}std::optional<${type}> gea_origin_field; gea::NativeFieldRead gea_origin_read(gea_origin_field); ` +
        `if (!${actual}->gea_readOwnFieldNative(gea_key, gea_origin_read)) ` +
        'gea::host::throwRuntimeError("TypeError", "a live native field has no source read protocol"); ' +
        'return std::move(*gea_origin_field); })()'
      if (route.write !== null) {
        write = {
          value: route.write,
          statement:
            `return gea::nativeOwnFieldsWritable(${actual}) && ` +
            `${actual}->gea_writeOwnFieldNative(gea_key, gea::NativeFieldWrite::exact(*gea_value), gea::nativeIsExtensible(${actual}));`
        }
      }
    } else if (read.kind === 'record-accessor') {
      got = `${cppBodyName(read.getter)}(${[...environment(field.key, read.getter, 'getter'), actual].join(', ')})`
      if (read.setter !== null && route.write !== null)
        write = {
          value: route.write,
          statement: `${cppBodyName(read.setter)}(${[...environment(field.key, read.setter, 'setter'), actual, '*gea_value'].join(', ')}); return true;`
        }
    } else if (read.kind === 'sidecar' && read.from !== 'index') {
      got = `gea::nativeSidecarGetText(${actual}, gea::detail::expandoFor(gea::refCastToVoid(${actual}), false), ${cppStringLiteral(field.key)})`
      write = { value: route.write!, statement: `return gea::nativeDynamicSet(${actual}, gea_key, *gea_value);` }
    } else if (read.kind === 'class-accessor') {
      if (source.kind !== 'class-ref') return null
      const member = classMemberOf(ctx.classes, source.declaration, field.key)
      if (member?.kind !== 'accessor' || member.accessor.getter === null) return null
      const getter = member.accessor.getter
      const dispatch = ctx.virtualDispatch?.get(virtualDispatchKey(source.declaration, field.key, 'get'))
      if (dispatch && representationKey(dispatch.result) !== representationKey(route.read)) return null
      got = dispatch
        ? `${actual}->${cppVirtualMemberName(field.key, 'get')}()`
        : `${cppBodyName(getter)}(${[...environment(field.key, getter, 'getter'), actual].join(', ')})`
      if (route.write !== null && member.accessor.setter !== null) {
        const setter = member.accessor.setter
        const dispatch = ctx.virtualDispatch?.get(virtualDispatchKey(source.declaration, field.key, 'set'))
        if (dispatch && representationKey(dispatch.parameters[0]?.value ?? { kind: 'void' }) !== representationKey(route.write)) return null
        write = {
          value: route.write,
          statement:
            (dispatch
              ? `${actual}->${cppVirtualMemberName(field.key, 'set')}(*gea_value);`
              : `${cppBodyName(setter)}(${[...environment(field.key, setter, 'setter'), actual, '*gea_value'].join(', ')});`) +
            ' return true;'
        }
      }
    } else if (read.kind === 'bound-method' || read.kind === 'method-value') {
      if (source.kind !== 'class-ref') return null
      const method = optionalMethodPayloadOf(field.value)
      if (read.kind === 'method-value')
        got = nativeClassMethodReadText(ctx, source, method, field.key, actual, (_site, from, into, value) =>
          structuralLeafText(ctx, from, into, value)
        )
      else {
        const recipe = ctx.structuralMethods.find((entry) => entry.declaration === source.declaration && entry.key === field.key)
        if (!recipe) throw new Error(`a live method view has no source recipe for ${field.key}`)
        const held = nativeClassMethodReadText(ctx, source, recipe.source, field.key, actual, (_site, from, into, value) =>
          structuralLeafText(ctx, from, into, value)
        )
        const erased = held === null ? null : namedConversionText(ctx, 'live-view:method', recipe.method, held)
        got = erased === null ? null : namedConversionText(ctx, 'live-view:method-frame', recipe.adaptation, erased)
      }
      if (got !== null && method !== field.value) got = `${cppTypeOf(field.value)}(${got})`
    }
    if (got === null) return null
    const leaf =
      read.kind === 'held' && representationKey(route.read) !== representationKey(field.value)
        ? ctx.structuralConversions.get(structuralConversionKey(route.read, field.value))
        : undefined
    const declared = leaf === undefined ? null : namedConversionText(ctx, 'live-view:declared-field', leaf, got)
    accesses.push({
      key: field.key,
      read: { value: route.read, text: got },
      ...(declared === null ? {} : { declared: { value: field.value, text: declared } }),
      write
    })
  }
  return liveFieldViewText(live, text, accesses)
}

/**
 * What a built view still owes once its block is allocated: the open keys of
 * an indexed source. Its source origin already belongs to that allocation.
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
  return allocated
}
