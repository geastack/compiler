import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { Representation } from '../representation/model.js'
import { abiKey, arrayExtensionKey, representationKey } from '../representation/model.js'
import { optionalOf } from '../representation/optional.js'
import type { ConversionCapability, ConversionNode, ConversionNodeId } from './algebra.js'
import { createConversionDerivationContext, deriveConversionCapability } from './derive.js'
import { validateConversionGraph } from './graph-validation.js'
import type { ClassifierMaterializerPair, ConversionRuntimeRegistry } from './registry.js'

/**
 * The conversion graph for one sealed representation plan.
 *
 * A node exists for every distinct carrier the plan selected, because the
 * question "can a dynamic value become this carrier" is asked per carrier, not
 * per result: two results holding the same carrier have the same answer, and
 * minting two nodes for them would let the two answers drift apart.
 *
 * Nodes are keyed by `representationKey` for the same reason the plan uses it
 * to detect conflicts -- it is the one place carrier identity is defined, and a
 * second keying scheme here would be a second identity.
 */

export interface ConversionGraph {
  readonly nodes: ReadonlyMap<ConversionNodeId, ConversionNode>
}

/**
 * A registry with nothing installed.
 *
 * Every lookup answers `null`, so every capability derives to `never` with a
 * stated reason. That is the honest description of a backend whose conversion
 * primitives have not been written yet: the gaps are enumerated rather than
 * hidden behind a capability nobody implemented.
 */
export const emptyConversionRegistry: ConversionRuntimeRegistry = Object.freeze({
  scalarMaterializer: () => null,
  stringMaterializer: () => null,
  symbolMaterializer: () => null,
  nullMaterializer: () => null,
  undefinedMaterializer: () => null,
  classRefMaterializer: () => null,
  nativeHandleMaterializer: () => null,
  recordMaterializer: () => null,
  recordRefMaterializer: () => null,
  arrayObjectDomain: () => null,
  functionMaterializer: () => null,
  functionValueDispatchMaterializer: () => null,
  optionalAbsenceTag: (_absence: 'null' | 'undefined') => null,
  boxedIdentityMaterializer: () => null,
  taggedUnionArmClassifier: () => null,
  narrowing: () => null,
  widening: () => null,
  recasting: () => null,
  staticRecipe: () => null,
  coercion: () => null
})

/**
 * Every carrier a narrowing can land on, given the one the cell holds.
 *
 * The list is the shape of the source, not a search: an optional narrows to its
 * payload, a union narrows to one of its arms, and an optional *of* a union
 * narrows three ways -- the union still wrapped, straight through to an arm
 * because `if (x && typeof x === 'string')` proves both facts at once, or to an
 * optional of an arm because `if (typeof x !== 'string')` proves which arm is
 * live and says nothing at all about presence.
 *
 * Arms are deduplicated by carrier rather than by position. A union whose arms
 * are `string | string | string` at the *carrier* level -- three different
 * declared types that all lower to one C++ type -- offers exactly one narrowing
 * target, and the choice of which arm is live is the load's problem, not this
 * enumeration's.
 */
/**
 * The narrowing targets reachable by ruling out exactly one arm -- the shape a
 * single `typeof`/`instanceof` guard's negative branch proves (`h instanceof
 * Headers` inside `const h: Headers | Record<string,string> |
 * [string,string][]` leaves the `else` branch holding the other two, still a
 * union). Ruling out more than one arm at once is two guards, which reads as
 * two successive single-arm narrowings rather than a target this enumeration
 * would have to search combinatorially for -- so this stays linear in the
 * arm count, never exponential.
 *
 * `< 3` returns nothing on purpose: a two-arm union with one arm ruled out
 * narrows to that ONE remaining arm, which the plain per-arm enumeration
 * right below already offers.
 */
const dropOneArmUnionsOf = (union: Extract<Representation, { kind: 'tagged-union' }>): readonly Representation[] => {
  if (union.arms.length < 3) return []
  // `TaggedUnionArm.tag` is minted once, in representation/union.ts, as the
  // arm's zero-based POSITION stringified -- representationKey embeds it
  // verbatim. Dropping an arm without renumbering the survivors leaves their
  // tags citing their OLD position, so this subset's key never matches the
  // real, independently-derived representation of the same union elsewhere
  // in the plan, and no conversion node ever gets minted for it.
  return union.arms.map((_, dropped) => ({
    kind: 'tagged-union' as const,
    arms: union.arms.filter((__, index) => index !== dropped).map((arm, position) => ({ ...arm, tag: String(position) }))
  }))
}

/**
 * A `dynamic` source is deliberately never proposed here, and never by
 * `subsetNarrowingTargetsOf` below either -- both only ever branch on
 * `source.kind === 'tagged-union'` or `'optional'`, so for `source.kind ===
 * 'dynamic'` this falls straight to the final `return []`. That makes
 * `buildConversionGraph`'s narrowing loop (which enumerates candidates by
 * calling this pair of functions on each `referenced` source) structurally
 * unable to ever call `registry.narrowing(dynamicSource, taggedUnionTarget)`
 * -- a `narrowing` branch keyed on `source.kind === 'dynamic'` would be dead
 * code no matter how correct its own admission test is. Confirmed by
 * building exactly that branch once (targets/cpp/conversions.ts, since
 * reverted) and finding it never fired.
 *
 * `dynamic -> tagged-union` is not narrowing at all -- there is no narrower
 * fact already proven about a `dynamic` value the way `if (tag)` proves
 * presence for `optional`, or a checker-narrowed union arm proves absence of
 * the others. It is the SAME classification `buildConversionGraph`'s first,
 * unconditional loop already mints a node for on every referenced target
 * (`source: { kind: 'dynamic', ... }`, `capability:
 * deriveConversionCapability(target, context)`), which for a tagged-union
 * target routes to `conversion/derive.ts`'s `deriveTaggedUnion` and gates on
 * `registry.taggedUnionArmClassifier` returning a non-null, pairwise-disjoint
 * classifier for every arm -- the real admission point, installed in
 * `targets/cpp/conversions.ts`'s `createCppConversionRegistry` rather than
 * proposed as a narrowing target here.
 */
/**
 * One step of narrowing, split by whether the closure below may keep
 * stepping from the result.
 *
 * `nested` is what a guard proves ABOUT THE SHAPE -- an arm, a payload, an
 * absence -- and a further guard can prove more about an arm that is itself
 * a sum, so the closure steps into these. `subsets` are the drop-one-arm
 * unions (and their optionals): the same union with one arm ruled out. They
 * are targets in their own right, but stepping from one of them again only
 * rules out a SECOND arm of the same union, and that is not a level of
 * nesting -- it is `dropOneArmUnionsOf`'s "two successive single-arm
 * narrowings", and the enumeration must never search it combinatorially.
 *
 * It did. The closure treated every target alike, so a union of N arms
 * produced C(N,2) drop-two unions at its second level and C(N,3) at its
 * third, each keyed by digesting N arm keys. TypeScript's own compiler
 * carries `Node` unions past a hundred arms; the representations stage ran
 * 25 minutes without returning, and a CPU profile was 85% inside this
 * closure's `representationKey`. A referenced multi-arm subset is still
 * proposed -- `subsetNarrowingTargetsOf` draws it from `referenced`, one
 * program-bounded scan, which is the only affordable way to reach it.
 */
interface NarrowingSteps {
  readonly nested: readonly Representation[]
  readonly subsets: readonly Representation[]
}

const noNarrowingSteps: NarrowingSteps = { nested: [], subsets: [] }

const narrowingStepsOf = (source: Representation): NarrowingSteps => {
  if (source.kind === 'tagged-union') {
    // A union whose absence lives INSIDE an arm's own optional narrows to an
    // OPTIONAL of another arm, which neither the bare arms nor the
    // drop-one-arm unions reach. hono's `compose` binds `let handler` to a
    // `Function | (Next | undefined)` cell -- arms `record` and
    // `optional(callable)` -- and reads it back as `Function | undefined`.
    // The absence tag comes from the optional arm that holds it, because that
    // is the only absence this union can express.
    //
    // The absence may also be an arm of its OWN -- three's `@type {?Array<Plane>}`
    // field is `undefined | null | Array<Plane>` (a JS field is readable before
    // its constructor writes it, so the census tags both absences), and
    // `if ( srcPlanes !== null )` rules out exactly one of them. What is left is
    // one absence beside one value, which IS an optional -- and every read past
    // that guard carries it. Without this the cell answered the three-arm union
    // and its guarded reads answered `optional(Array<Plane>, undefined)`, with
    // no pair between them in the graph: 4 unmet `binding-read-conversion`
    // obligations on the three.js app for one field, and the same shape wherever a
    // nullable JSDoc field is guarded. `targets/cpp/conversions.ts` already
    // installs `tagged-union -> optional(arm)` (`live-arm-optional`); only the
    // pairing was missing.
    const absences: readonly ('null' | 'undefined')[] = [
      ...new Set(
        source.arms.flatMap((arm) =>
          arm.value.kind === 'optional'
            ? [arm.value.absence]
            : arm.value.kind === 'undefined'
              ? (['undefined'] as const)
              : arm.value.kind === 'null'
                ? (['null'] as const)
                : []
        )
      )
    ]
    const optionalArms = source.arms
      .filter((arm) => arm.value.kind !== 'optional' && arm.value.kind !== 'undefined' && arm.value.kind !== 'null')
      .flatMap((arm) => absences.map((absence) => ({ kind: 'optional', payload: arm.value, absence }) as const))
    return { nested: distinctByKey([...source.arms.map((arm) => arm.value), ...optionalArms]), subsets: dropOneArmUnionsOf(source) }
  }
  if (source.kind !== 'optional') return noNarrowingSteps
  // The ABSENT side is a narrowing target too, and it had no pairing at all.
  //
  // `if ( dstArray === null )` proves the cell holds absence, and every read
  // inside that branch carries the absent value's OWN carrier -- `null`, whose
  // C++ value is `nullptr`, or `undefined`. This enumeration offered only the
  // present side, so those reads asked for an `optional(T,null) -> null`
  // conversion that nothing had ever proposed a node for. three's
  // `WebGLClipping` does it twice on one field.
  const absent = { kind: source.absence } as const
  const payload = source.payload
  if (payload.kind !== 'tagged-union') return { nested: distinctByKey([payload, absent]), subsets: [] }
  const arms = payload.arms.map((arm) => arm.value)
  const subsetUnions = dropOneArmUnionsOf(payload)
  return {
    nested: distinctByKey([
      payload,
      absent,
      ...arms,
      ...arms.map((arm) => ({ kind: 'optional', payload: arm, absence: source.absence }) as const)
    ]),
    subsets: distinctByKey([
      ...subsetUnions,
      // The subset union still wrapped in optional -- `if (x !== undefined &&
      // typeof x !== 'number')` proves which arm is excluded but says nothing
      // about presence, so the live narrowing keeps the absence tag.
      ...subsetUnions.map((sub) => ({ kind: 'optional', payload: sub, absence: source.absence }) as const)
    ])
  }
}

/**
 * Every carrier a narrowing can reach, following arms that are THEMSELVES
 * unions or optionals.
 *
 * `narrowingStepsOf` strips exactly one level, and one level is not what the
 * language proves. three's JSDoc nullable field is `undefined | null | X`, and
 * when `X` is itself a union -- `?(string|number|boolean)` -- a guard past the
 * two absences lands inside `X`: `undefined | null | (string|number)` narrowed
 * to `number` is two steps, and the outer shape narrowed to the same outer
 * shape with a SMALLER inner union is two steps as well. Neither pairing was
 * ever proposed, so no node was minted and every such read reported a missing
 * conversion for a recipe that already exists -- `emit-narrowing.ts`'s
 * `narrowedUnionSubsetText` recurses one level in for exactly this shape and
 * had no obligation counterpart.
 *
 * Depth-bounded rather than fixpointed, and deduplicated by key. Each step
 * strips one level of nesting so it terminates on its own for a finite carrier,
 * but a `Representation` graph may be genuinely cyclic (the standard way to
 * spell a recursive type), which is the same hazard `ConversionDerivationContext`
 * guards with `inProgress`. Three levels is what the shapes in play need: an
 * optional over a union over a union.
 */
const NARROWING_DEPTH = 3

/**
 * Memo for the two functions below, keyed by the source's STRUCTURAL key.
 *
 * `representationKey` has its own memo, but it is keyed by object IDENTITY --
 * and the closure walk below MINTS representations as it goes (the absent
 * side, `dropOneArmUnionsOf`'s one-arm-smaller unions, `distinctByKey`'s
 * arrays). Every minted object is a fresh miss, so an unmemoized closure pays
 * a full structural rebuild, crypto digest included, for values it has already
 * built -- and `narrowingReachesTarget` asks for the same closure twice, once
 * up front and again inside a RECURSIVE `reaches`. Measured on the three.js app, the
 * closure and the keying it forces were about 16% of a 58s compile.
 *
 * Sound to memo because the walk is a pure function of the representation: it
 * reads `narrowingStepsOf` and nothing else, and representations are immutable
 * value objects. Keyed structurally rather than by identity precisely so two
 * equal-but-distinct mintings share one answer, which is the whole point.
 */
const narrowingClosures = new Map<string, { readonly values: readonly Representation[]; readonly keys: ReadonlySet<string> }>()

/** The closure's members' keys, which is all either caller actually tests. */
const narrowingClosureKeysOf = (source: Representation): ReadonlySet<string> => narrowingClosureEntryOf(source).keys

const narrowingClosureOf = (source: Representation): readonly Representation[] => narrowingClosureEntryOf(source).values

const narrowingClosureEntryOf = (
  source: Representation
): { readonly values: readonly Representation[]; readonly keys: ReadonlySet<string> } => {
  const sourceCacheKey = representationKey(source)
  const remembered = narrowingClosures.get(sourceCacheKey)
  if (remembered !== undefined) return remembered
  const values = buildNarrowingClosure(source)
  const entry = { values, keys: new Set(values.map(representationKey)) }
  narrowingClosures.set(sourceCacheKey, entry)
  return entry
}

const buildNarrowingClosure = (source: Representation): readonly Representation[] => {
  const found = new Map<string, Representation>()
  const sourceKey = representationKey(source)
  let frontier: readonly Representation[] = [source]
  for (let level = 0; level < NARROWING_DEPTH; level++) {
    const next: Representation[] = []
    for (const one of frontier) {
      const steps = narrowingStepsOf(one)
      for (const target of steps.nested) {
        const key = representationKey(target)
        if (key === sourceKey || found.has(key)) continue
        found.set(key, target)
        next.push(target)
      }
      // A leaf: found, never stepped from again. See `NarrowingSteps`.
      for (const target of steps.subsets) {
        const key = representationKey(target)
        if (key === sourceKey || found.has(key)) continue
        found.set(key, target)
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return [...found.values()]
}

/**
 * Whether the supplied `target` is reachable from `source` by narrowing.
 *
 * The ordinary closure covers nested payload selection and the one-arm subset
 * a single guard creates. A target already present in the program can also be
 * the same outer sum with a smaller inner sum after several guards. Recognize
 * that supplied shape recursively instead of enumerating its possible
 * subsets: each target arm must have an exact, ordinarily narrowed, class-
 * descendant, or recursively narrowed home in a source arm. Pair memoization
 * keeps recursive representations finite. This one predicate is shared by
 * graph proposal and backend admission so they cannot disagree.
 */
const reachesMemo = new Map<string, boolean>()

export const narrowingReachesTarget = (source: Representation, target: Representation): boolean => {
  const targetKey = representationKey(target)
  if (narrowingClosureKeysOf(source).has(targetKey)) return true
  // Module level for the same reason `narrowingClosureOf`'s cache above is:
  // `reaches(from, to)` is a pure structural question about two immutable
  // representations, so the answer is the same for every caller, and a memo
  // minted per call throws away the whole table between questions that
  // overwhelmingly repeat. `active` stays per call -- it is the cycle guard for
  // THIS descent, not a fact about the graph, and sharing it would let one
  // call's in-progress pair read as a settled `false` in another.
  const active = new Set<string>()
  const reaches = (from: Representation, to: Representation): boolean => {
    const fromKey = representationKey(from)
    const toKey = representationKey(to)
    if (fromKey === toKey) return true
    if (narrowingClosureKeysOf(from).has(toKey)) return true
    const pair = `${fromKey}->${toKey}`
    const known = reachesMemo.get(pair)
    if (known !== undefined) return known
    if (active.has(pair)) return false
    active.add(pair)
    let result =
      from.kind === 'class-ref' && to.kind === 'class-ref' && from.ownership === to.ownership && to.ancestors.includes(from.declaration)
    if (!result && from.kind === 'optional') {
      result = to.kind === 'optional' && from.absence === to.absence ? reaches(from.payload, to.payload) : reaches(from.payload, to)
    }
    if (!result && from.kind === 'tagged-union') {
      result =
        to.kind === 'tagged-union'
          ? to.arms.length >= 2 &&
            to.arms.length <= from.arms.length &&
            to.arms.every((targetArm) => from.arms.some((sourceArm) => reaches(sourceArm.value, targetArm.value)))
          : from.arms.some((arm) => reaches(arm.value, to))
    }
    active.delete(pair)
    reachesMemo.set(pair, result)
    return result
  }
  return reaches(source, target)
}

/**
 * Whether `target`'s arms are all drawn from `source`'s -- a proper, more
 * than one arm dropped, subset -- so `target` is a live narrowing of `source`
 * that ruling out one arm at a time (`dropOneArmUnionsOf`) cannot reach in a
 * single step. Order-independent and duplicate-tolerant on purpose: this
 * mirrors `targets/cpp/conversions.ts`'s own `registry.narrowing` admission
 * test for a sub-union target exactly (`selected.arms.every(...source arm
 * exists...)`), which is the render-side authority for whether the pairing
 * this predicate approves actually gets a materializer. Duplicated rather
 * than imported because `conversion/build.ts` is backend-agnostic and
 * `conversions.ts` is the C++ target's own registry -- but the two must never
 * answer differently about the same pair, so if one changes, the other must.
 */
/**
 * A base-declared class handle read at one of its DESCENDANTS -- the narrowing
 * `instanceof` performs, which `narrowingStepsOf` cannot enumerate.
 *
 * `narrowingStepsOf` answers "what can this carrier narrow to" from the
 * carrier alone, and a `class-ref(Object3D)` states nothing about which
 * classes descend from it -- that is a fact about each OTHER class. So this is
 * a TEST, asked of the target, which does state its own ancestry. three's
 * `getDepthMaterial` writes `result = cond ? _distanceMaterial : _depthMaterial`
 * into a cell the checker widened to `undefined | null | Material` and reads
 * it back at the two-class union the assignment proved: an arm subset whose
 * arms are descendants of the source's own arm, and without this every read
 * past that assignment reported a conversion with no node.
 *
 * `targets/cpp/conversions.ts`'s `downcastsToDerived` is the same predicate on
 * the admission side, and `emit-narrowing.ts`'s `narrowedLoadText` renders it
 * -- all three off the carrier's own `ancestors`, so there is one authority.
 */
const narrowsToDescendantClass = (source: Representation, target: Representation): boolean =>
  source.kind === 'class-ref' &&
  target.kind === 'class-ref' &&
  source.ownership === target.ownership &&
  target.ancestors.includes(source.declaration)

/** The class handle a carrier holds outright, through at most one optional wrapper. */
const heldClassOf = (source: Representation): Extract<Representation, { kind: 'class-ref' }> | null => {
  if (source.kind === 'class-ref') return source
  if (source.kind === 'optional' && source.payload.kind === 'class-ref') return source.payload
  return null
}

/**
 * A base-class handle read at a UNION of its descendants -- `instanceof Mesh ||
 * instanceof Line || instanceof Points`, which is the guard three's
 * `WebGLShadowMap.renderObject` is written with once the gea plugin restores
 * real class tests in place of three's duck-typed `isMesh` flags.
 *
 * `narrowsToDescendantClass` answers this one arm at a time and
 * `subsetNarrowingTargetsOf`'s union branch answers it for a union SOURCE;
 * neither covers a class source read at a union target, so twenty reads past
 * that one guard carried an obligation nothing had proposed and the three.js app could
 * not certify at all. The renderer has always been able to spell it --
 * `targets/cpp/emit-narrowing.ts`'s `classFamilyLoadText` projects exactly
 * this, testing the most-specific family first and rebuilding the arm -- so
 * the gap was the capability side alone, which is the two-authorities shape:
 * fix the side that is wrong, never the consumer.
 *
 * Asked of the target because a `class-ref(Object3D)` states nothing about
 * which classes descend from it; each arm states its own ancestry.
 * `targets/cpp/conversions.ts` imports this rather than restating it so the
 * proposal and the admission cannot disagree about which pairs install.
 */
export const narrowsToDescendantClassUnion = (source: Representation, target: Representation): boolean => {
  const held = heldClassOf(source)
  if (held === null) return false
  // An optional target keeps the source's own absence around the projected
  // union; it never invents one, and it never changes which absence is worn.
  if (target.kind === 'optional' && source.kind === 'optional' && source.absence !== target.absence) return false
  const union = target.kind === 'optional' ? target.payload : target
  if (union.kind !== 'tagged-union' || union.arms.length === 0) return false
  return union.arms.every((arm) => narrowsToDescendantClass(held, arm.value))
}

/**
 * Wraps a `registry.narrowing` pair as the capability the printer actually
 * renders it with.
 *
 * Every narrowing pair is an `atom` except this one: a base handle narrowed
 * to a union of descendants needs `class-family`
 * (`conversion/algebra.ts`'s own doc on that kind says why -- its recipe,
 * `targets/cpp/emit-narrowing.ts`'s `classFamilyLoadText`, orders its cascade
 * over the whole-program class table, which the ctx-free chain every `atom`
 * renders through cannot see). Re-asking `narrowsToDescendantClassUnion`
 * here rather than having the caller remember which shape it minted keeps
 * the proposal (this predicate) and the wrap from ever disagreeing about
 * which pairs are which.
 */
export const narrowingCapabilityFor = (
  source: Representation,
  target: Representation,
  installed: ClassifierMaterializerPair
): ConversionCapability =>
  narrowsToDescendantClassUnion(source, target)
    ? { kind: 'class-family', materializer: installed.materializer }
    : { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }

const isArmSubsetOf = (
  source: Extract<Representation, { kind: 'tagged-union' }>,
  target: Extract<Representation, { kind: 'tagged-union' }>
): boolean => {
  if (target.arms.length < 2 || target.arms.length > source.arms.length) return false
  // An arm's home may be an arm the target's own arm NARROWS OUT OF, not only
  // one it equals -- which is also why the arm-count test is `>` and not `>=`.
  // three's `?(string|number|boolean)` field is `undefined | null |
  // (string|number|boolean)`, and a guard on the inner union leaves the SAME
  // three-arm outer shape with a smaller union in its `present` arm: same arm
  // count, genuinely narrower, and matching arms by key alone read it as a
  // union with no such arm at all. `emit-narrowing.ts`'s
  // `narrowedUnionSubsetText` already renders exactly this -- it searches for
  // an exact home first and then asks `narrowedLoadText` one level in -- and
  // had no obligation counterpart, so every such read reported a missing
  // conversion for a recipe that was already built.
  return target.arms.every((tarm) =>
    source.arms.some(
      (sarm) =>
        representationKey(sarm.value) === representationKey(tarm.value) ||
        narrowingReachesTarget(sarm.value, tarm.value) ||
        narrowsToDescendantClass(sarm.value, tarm.value)
    )
  )
}

/**
 * Every tagged union reachable by selecting through nested sum arms.
 *
 * A nullable union is represented as an outer tagged union whose `present`
 * arm can itself be a tagged union. Control flow may remove the two absence
 * arms and then reorder the surviving inner union's arms, so the read target
 * is a subset of the INNER union rather than of the published outer carrier.
 * Keep the walk confined to sum nesting: records and collections do not
 * become their contents when narrowed.
 */
const nestedTaggedUnionsOf = (source: Representation): readonly Extract<Representation, { kind: 'tagged-union' }>[] => {
  const found = new Map<string, Extract<Representation, { kind: 'tagged-union' }>>()
  const queue: Representation[] = [source]
  while (queue.length > 0) {
    const one = queue.pop()
    if (!one) continue
    if (one.kind === 'optional') {
      queue.push(one.payload)
      continue
    }
    if (one.kind !== 'tagged-union') continue
    const key = representationKey(one)
    if (found.has(key)) continue
    found.set(key, one)
    queue.push(...one.arms.map((arm) => arm.value))
  }
  return [...found.values()]
}

/**
 * Multi-arm narrowing targets `dropOneArmUnionsOf` cannot reach, found
 * without enumerating a single subset: `target` is never invented here, it is
 * always some OTHER representation `referencedRepresentations` already put in
 * the plan -- an explicit `as`-cast's own asserted type, a declared return
 * type, a parameter annotation, ... -- whose arms are a genuine subset of
 * `source`'s. hono's `_getQueryParam(url, key, true) as string[] | undefined
 * | Record<string, string[]>` (`utils/url.ts:314`) is the case: the cast
 * narrows the callee's real 4-arm return union down to the 2 array-bearing
 * arms, and the cast's own asserted type is what makes that 2-arm union a
 * member of `referenced` in the first place -- this only has to notice it is
 * already there, drawn one-for-one from `source`'s own arms.
 *
 * The cost this stays inside is `referenced.size` candidates examined once
 * per source union, an arm-count-independent, program-bounded scan -- never
 * the C(n,k) subsets a source union COULD narrow to, which is the
 * combinatorial growth `dropOneArmUnionsOf`'s own doc comment stays clear of
 * on purpose and this must too.
 */
const subsetNarrowingTargetsOf = (source: Representation, referenced: ReadonlyMap<string, Representation>): readonly Representation[] => {
  // A class handle's descendant unions are drawn from `referenced` by the same
  // one-scan rule the union branch below uses -- the target is never invented,
  // it is a carrier the plan already contains. Disjoint from that branch: a
  // carrier whose payload is a class-ref has no nested tagged union at all.
  if (heldClassOf(source) !== null) {
    return [...referenced.values()].filter((candidate) => narrowsToDescendantClassUnion(source, candidate))
  }
  if (source.kind === 'tagged-union' || source.kind === 'optional') {
    const unions = nestedTaggedUnionsOf(source)
    if (unions.length === 0) return []
    return [...referenced.values()].filter((candidate) => {
      // A BARE subset union is a candidate too, not only one that keeps the
      // source's own absence tag. Presence and arm-narrowing are proven by
      // separate guards and both proofs land on one read: mongodb's
      // `formatSort` writes `if (sort == null) return` and then `if (typeof
      // sort !== 'object') throw`, so the five reads after it are subsets with
      // no optional wrapper left at all -- which this branch, matching only
      // optional candidates, never offered. `targets/cpp/conversions.ts`'s
      // `narrowing` already accepts the pairing (its `selected` stays optional
      // only when the TARGET is); the recipe existed and was never asked for.
      if (candidate.kind === 'tagged-union') return unions.some((union) => isArmSubsetOf(union, candidate))
      if (source.kind !== 'optional' || candidate.kind !== 'optional' || candidate.absence !== source.absence) return false
      const payload = candidate.payload
      return payload.kind === 'tagged-union' && unions.some((union) => isArmSubsetOf(union, payload))
    })
  }
  return []
}

/**
 * Every carrier that can widen into the one given, the mirror image of
 * `narrowingStepsOf`.
 *
 * A tagged union's arms are exactly the values that can be stored as it --
 * `gea::TaggedUnion::ofArm<Index>` is a real constructor for each one. An
 * `optional` accepts two kinds of widening source: its bare payload, because
 * `gea::Optional<T>` declares its own converting constructor from `T` with no
 * union involved at all, and -- when the payload is itself a tagged union --
 * that union's own arm values too, which pass through the payload's widening
 * unchanged and then into the optional's.
 *
 * An arm still wearing its OWN optional widens too, into either shape of
 * target: `a && a.b` keeps `a` -- still optional -- on the branch where `a`
 * tested falsy, and the merge's own carrier can be the still-optional union
 * (absence really can reach the merge, the same way it reaches `a`) or, for
 * `a || b`/`a ?? b`'s truthy/present-kept branch, the bare union with no
 * absence at all (the checker has already ruled absence out there). Both
 * need the source's own presence read at the store, which is why
 * `emit-narrowing.ts`'s widening store, not `gea::Optional`'s converting
 * constructor, is what ends up performing it -- this only states that the
 * pairing is a real, structural one and not a search that happens to fail.
 */
const optionalArmSourcesOf = (arms: readonly Representation[], absences: readonly ('null' | 'undefined')[]): readonly Representation[] =>
  arms.flatMap((arm) => absences.map((absence) => optionalOf(arm, absence))).filter((candidate) => candidate.kind === 'optional')

/**
 * Every proper, PREFIX-shaped `function-value-dispatch` source a callable
 * target can widen from -- structural candidates for `gea::CallableObject`'s
 * prefix-dropping converting constructor (`targets/cpp/emit-narrowing.ts`'s
 * `dropsUnboundParameters`, `gea_runtime.h`'s own `IsTypePrefix`-gated
 * constructor). hono's own `Hono.getPath`: `this.getPath = (strict ?? true)
 * ? (options.getPath ?? getPath) : getPathNoStrict` merges two
 * `(request: Request) => string` values into a field declared
 * `(request: Request, options?: {env?}) => string` -- a real value in the
 * program is a callable with exactly the target's own LEADING run of
 * parameters and nothing else.
 *
 * Derived purely from the target's own shape, the same discipline every
 * other branch of this function follows: this is not a search over the
 * plan's carriers, only every candidate the target's own arity admits, in
 * order from zero parameters (`dropArguments`'s own case) up to one short of
 * the full count. `buildConversionGraph`'s own intersection with the plan's
 * referenced carriers is what decides whether any of them is a value the
 * program actually holds -- exactly as it already does for every other
 * branch here.
 *
 * Receiver-bearing and rest-taking callables are excluded: the runtime
 * constructor's own proof is over a fixed `Arguments...` pack alone, so
 * either one is not this shape (mirrors `dropsUnboundParameters`'s identical
 * receiver exclusion).
 */
const callablePrefixSourcesOf = (target: Representation): readonly Representation[] => {
  if (
    (target.kind !== 'function-value-dispatch' &&
      target.kind !== 'function' &&
      target.kind !== 'function-family' &&
      target.kind !== 'function-value-family') ||
    target.abi.receiver !== null ||
    target.abi.restFrom !== null
  ) {
    return []
  }
  const abi = target.abi
  const prefixes: Representation[] = []
  for (let length = 0; length < abi.parameters.length; length++) {
    prefixes.push({
      kind: 'function-value-dispatch',
      abi: { parameters: abi.parameters.slice(0, length), result: abi.result, receiver: null, restFrom: null }
    })
  }
  return prefixes
}

/**
 * Every zero-parameter `function-value-dispatch` source a callable target
 * can widen from where its result is one ARM of the target's own tagged
 * union result -- structural candidates for `gea_runtime.h`'s
 * `ResultWidensIntoArm`-gated converting constructor
 * (`targets/cpp/emit-narrowing.ts`'s `dropsAllParametersIntoResultArm`).
 * hono's own `Context.notFound`: `this.#notFoundHandler ??=
 * () => createResponseInstance()` merges a `() => Response` into a field
 * declared `(c: Context) => Response | Promise<Response>` -- a real value in
 * the program is a zero-parameter callable whose result is exactly the
 * `Response` arm, never the union itself.
 *
 * Composes `callablePrefixSourcesOf`'s own zero-length case (arity alone)
 * with one substitution neither that function nor `optionalArmSourcesOf`
 * performs: the RESULT narrowed to a single arm rather than left at the
 * target's own. Gated identically to `callablePrefixSourcesOf` -- no
 * receiver, no rest -- plus the target actually declaring at least one
 * parameter (a nullary target has no arity gap to fill this way at all,
 * `dropsUnboundParameters`'s own case) and a tagged-union result to narrow
 * into in the first place.
 */
const callableResultArmSourcesOf = (target: Representation): readonly Representation[] => {
  if (
    (target.kind !== 'function-value-dispatch' &&
      target.kind !== 'function' &&
      target.kind !== 'function-family' &&
      target.kind !== 'function-value-family') ||
    target.abi.receiver !== null ||
    target.abi.restFrom !== null ||
    target.abi.parameters.length === 0 ||
    target.abi.result.kind !== 'tagged-union'
  ) {
    return []
  }
  return target.abi.result.arms.map((arm) => ({
    kind: 'function-value-dispatch' as const,
    abi: { parameters: [], result: arm.value, receiver: null, restFrom: null }
  }))
}

const wideningSourcesOf = (target: Representation): readonly Representation[] => {
  // These carriers encode T | null in their own empty state, without an
  // optional wrapper. The backend must still license the actual store.
  if (target.kind === 'native-handle' || (target.kind === 'class-ref' && target.ownership === 'shared-refcount')) {
    return [{ kind: 'null' }]
  }
  const callablePrefixes = [...callablePrefixSourcesOf(target), ...callableResultArmSourcesOf(target)]
  // A bare `Function` is the one dynamic carrier that itself promises
  // callability. It can therefore be a structural source for an evaluated
  // callable slot whose backend installs an ABI adapter. Keep the provenance
  // exact: other dynamic reasons make no such source-level promise and reach
  // a callable only through the generic checked dynamic materializer.
  if (target.kind === 'function-value-dispatch') {
    callablePrefixes.push({ kind: 'dynamic', reason: 'untyped-callable' })
  }
  if (callablePrefixes.length > 0) return callablePrefixes
  if (target.kind === 'optional') {
    // `gea::Optional<T>` itself declares a converting constructor from `T`, so
    // the bare payload widens with no union involved at all -- the payload is
    // always a widening source for its own optional, independent of whether
    // the payload also happens to be a tagged union.
    const payload = target.payload
    const arms = payload.kind === 'tagged-union' ? payload.arms.map((arm) => arm.value) : []
    // The target's own absence tag is the only one an arm's optional can wear
    // here: an `&&` merge keeps `a`'s own optional unchanged, and `a`'s
    // absence tag is exactly the merge's (`representation/optional.ts` never
    // lets a carrier disagree with itself about which value means absent).
    //
    // The bare absence marker itself -- `{kind: target.absence}` -- is a
    // source too, and a distinct one from the payload: a value whose own
    // TYPE is exactly `undefined` (hono's `E['Bindings']` resolved for
    // `BlankEnv`, which genuinely has no such field) stores as the optional's
    // empty state with no payload conversion at all. `emit-narrowing.ts`'s
    // `emptyOptionalText` already renders this (`written.kind === held.
    // absence`); without offering the source here `registry.widening` is
    // simply never asked, and a value that is honestly, statically absent
    // refuses for a conversion the emitter could already perform.
    // ...and every source the PAYLOAD itself widens from. The two rules
    // already exist and simply did not compose: a callable target admits its
    // own proper prefixes (`callablePrefixSourcesOf`), an optional target
    // admits its own payload, and `((gl, v) => void)` written where
    // `((gl, v, textures) => void) | undefined` is expected is both at once.
    // three's `getSingularSetter` is 30 returns of exactly that shape --
    // `setValueV1f( gl, v )` and `setValueT1( gl, v, textures )` returned from
    // one `switch` whose fall-through makes the slot optional.
    //
    // The emitter renders it by constructing the payload EXPLICITLY
    // (`convertedValueText`'s optional branch): C++ allows one user-defined
    // conversion per implicit sequence, and `gea::CallableObject`'s
    // prefix-dropping constructor followed by `gea::Optional<T>`'s converting
    // constructor is two. Naming the payload type spends one of them
    // explicitly, which is why offering this source here is safe rather than
    // a claim the backend cannot honor.
    const payloadSources = [
      ...callablePrefixSourcesOf(payload),
      ...callableResultArmSourcesOf(payload),
      ...(payload.kind === 'optional' || payload.kind === 'tagged-union' ? wideningSourcesOf(payload) : [])
    ]
    return distinctByKey([{ kind: target.absence }, payload, ...arms, ...payloadSources, ...optionalArmSourcesOf(arms, [target.absence])])
  }
  if (target.kind !== 'tagged-union') return []
  // The bare mirror of the branch above: `||`/`??` prove presence before
  // keeping the left side, so the merge's own carrier never needs an absence
  // flag even though the kept operand's own carrier still has one. A bare
  // target states no preference between the two absence spellings, so both
  // are offered as real sources at the payload level.
  return distinctByKey([
    ...target.arms.map((arm) => arm.value),
    // Both-absence carriers group their present alternatives under a second
    // sum. A bare value still reaches its exact leaf through that group;
    // the installed materializer must prove and construct the entire path.
    ...target.arms.flatMap((arm) =>
      arm.value.kind === 'optional' || arm.value.kind === 'tagged-union' ? wideningSourcesOf(arm.value) : []
    ),
    ...optionalArmSourcesOf(
      target.arms.map((arm) => arm.value),
      ['null', 'undefined']
    )
  ])
}

const distinctByKey = (representations: readonly Representation[]): readonly Representation[] => {
  const seen = new Map<string, Representation>()
  for (const representation of representations) {
    const key = representationKey(representation)
    if (!seen.has(key)) seen.set(key, representation)
  }
  return [...seen.values()]
}

/**
 * Each distinct carrier once, paired with its key.
 *
 * The pair-wise loops below are quadratic by nature -- "which of these can
 * convert into which" is a question about pairs -- so what decides whether they
 * are affordable is the cost of one iteration and the size of `n`. Both were
 * wrong when read straight off `plan.selected`:
 *
 *   - `plan.selected` is keyed by RESULT, not by carrier. A program publishes
 *     one entry per SSA result, so `ios-metal-world-game` has 95,670 of them
 *     naming vastly fewer distinct carriers. Conversions are a fact about
 *     carriers, so every duplicate is an iteration that re-derives an answer
 *     already in `nodes`.
 *   - `representationKey` is a recursive string build over the whole carrier
 *     shape, with no memo. Calling it inside the inner loop -- twice per pair,
 *     once for an invariant target -- makes each iteration cost the depth of
 *     the representation rather than a comparison.
 *
 * Together those turned one merged loop into ~15x the corpus's whole compile
 * time. Keying once up front makes the inner comparison a string equality and
 * the outer bound the number of distinct carriers, which is what the question
 * was ever about.
 */
const keyedDistinct = (representations: Iterable<Representation>): readonly (readonly [string, Representation])[] => {
  const seen = new Map<string, Representation>()
  for (const representation of representations) {
    const key = representationKey(representation)
    if (!seen.has(key)) seen.set(key, representation)
  }
  return [...seen].map(([key, representation]) => [key, representation] as const)
}

/**
 * A callable convention's own carriers -- every one of a conversion's
 * candidate sources or targets, the same way any other representation is.
 */
const abiRepresentations = (abi: {
  parameters: readonly { value: Representation }[]
  result: Representation
  receiver: Representation | null
}): readonly Representation[] => [
  ...abi.parameters.map((parameter) => parameter.value),
  abi.result,
  ...(abi.receiver ? [abi.receiver] : [])
]

/**
 * The ABI identity for carriers that are physically a CallableObject.  A
 * declaration/family token changes how a callable was authenticated, not the
 * frame it stores, so an exact frame can enter an evaluated-dispatch slot
 * without an adapter.  Keep constructors out: their C++ object has a distinct
 * call/construct protocol even when one call ABI happens to look alike.
 */
const callableObjectAbiKey = (representation: Representation): string | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return abiKey(representation.abi)
    default:
      return null
  }
}

/**
 * The `Representation`s nested one level inside another -- an ABI's
 * parameters/result/receiver, a record's fields, a container's element, and
 * so on. `class-ref`/`native-record-ref` deliberately contribute nothing:
 * both name their layout by `shapeId` rather than nesting it, which is what
 * keeps a self-referential named type finite, and closing over a name would
 * need the deriver this module -- generic representation algebra, with no
 * knowledge of the structural table -- does not have.
 *
 * This is what lets `referencedRepresentations` below see an ABI parameter
 * type or a declared field type as a conversion target even when no OTHER
 * result in the program happens to be selected as that exact carrier: see
 * that function's own comment for why a carrier reachable only through
 * nesting still needs a node.
 */
const nestedRepresentationsOf = (representation: Representation): readonly Representation[] => {
  switch (representation.kind) {
    case 'native-handle':
      return [
        ...(representation.call ? abiRepresentations(representation.call) : []),
        ...(representation.construct ? abiRepresentations(representation.construct) : [])
      ]
    case 'record':
      return representation.fields.map((field) => field.value)
    case 'record-with-index':
      return [...representation.fields.map((field) => field.value), ...representation.indexes.map((index) => index.value)]
    case 'proxy-object':
      return [representation.target, representation.handler]
    case 'borrowed-ref':
      return [representation.referent]
    case 'array-object':
      return [representation.element, ...(representation.extension ?? []).map((field) => field.value)]
    case 'dense-buffer':
    case 'native-sequence':
    case 'iterator':
      return [representation.element]
    case 'promise':
    case 'dictionary':
      return [representation.value]
    case 'keyed-collection':
      return representation.value ? [representation.key, representation.value] : [representation.key]
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-family':
    case 'function-value-dispatch':
      return abiRepresentations(representation.abi)
    case 'function-and-constructor':
      return [...abiRepresentations(representation.call), ...abiRepresentations(representation.construct)]
    case 'optional':
      return [representation.payload]
    case 'tagged-union':
      return representation.arms.map((arm) => arm.value)
    default:
      return []
  }
}

/**
 * Every representation the plan's own selected carriers reference, directly
 * or through nesting -- the closure `buildConversionGraph`'s four minting
 * loops walk, in place of `plan.selected.values()` alone.
 *
 * A callable's declared parameter type, a record's declared field type, an
 * array's element type -- none of these is necessarily itself the carrier
 * some OTHER result in the program was independently selected to hold. A
 * program whose only dynamic value is a caught `error` passed to `String`
 * has no binding anywhere typed `optional(dynamic,undefined)` (`String`'s
 * own `(value?: any)` parameter) -- so `plan.selected.values()` alone never
 * visits that carrier, `buildConversionGraph` never asks the registry
 * whether a dynamic value widens into it, and a conversion the registry
 * (`targets/cpp/conversions.ts`'s `widening`) already proves -- the same
 * `gea::Optional<T>` converting-constructor case `emit-narrowing.ts`'s
 * `convertedValueText` renders at the call site -- reads back as "no
 * conversion node" purely because nothing ever minted one, not because the
 * backend cannot spell it. `preflight/invocation-arguments.ts`,
 * `property-value.ts`, and `array-literal-elements.ts` all check a target
 * exactly like this -- an ABI parameter, a declared field, an array element
 * -- so all three need this closure to ever see a real answer instead of a
 * permanent false "missing".
 *
 * Finite by construction: `nestedRepresentationsOf` never descends through
 * `class-ref`/`native-record-ref` (both name their layout by `shapeId`
 * rather than nesting it), so a self-referential declared type cannot loop
 * here the same way it cannot loop at `representationKey`.
 */
const referencedRepresentations = (
  plan: SealedRepresentationPlan,
  constants: Iterable<Representation>
): ReadonlyMap<string, Representation> => {
  const known = new Map<string, Representation>()
  const queue: Representation[] = [...plan.selected.values(), ...constants]
  while (queue.length > 0) {
    const representation = queue.pop()
    if (!representation) continue
    const key = representationKey(representation)
    if (known.has(key)) continue
    known.set(key, representation)
    queue.push(...nestedRepresentationsOf(representation))
  }
  return known
}

export const buildConversionGraph = (
  plan: SealedRepresentationPlan,
  registry: ConversionRuntimeRegistry = emptyConversionRegistry,
  constants: Iterable<Representation> = []
): ConversionGraph => {
  const context = createConversionDerivationContext(registry)
  const nodes = new Map<ConversionNodeId, ConversionNode>()
  const referenced = referencedRepresentations(plan, constants)
  const genericDynamicSource: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const genericDynamicKey = representationKey(genericDynamicSource)

  for (const representation of referenced.values()) {
    const id = representationKey(representation)
    if (nodes.has(id)) continue
    nodes.set(id, {
      id,
      // Conversion always starts from the dynamic carrier: it is the only
      // source that needs classifying at all. A statically typed value already
      // has its carrier, so there is nothing to decide.
      source: genericDynamicSource,
      target: representation,
      capability: deriveConversionCapability(representation, context)
    })
  }

  // Narrowing reads, the one conversion that does not start from the dynamic
  // carrier.
  //
  // A cell holding `Optional<string>` read as `string` inside `if (tag)` is not
  // a classification -- the checker already proved presence, and re-deciding it
  // here would be a second authority answering a settled question. What it is,
  // is a *load*: the payload out of the cell, or the live arm out of a union.
  // That load still needs a recipe, because a backend that cannot spell one
  // would otherwise certify and then refuse at emission, so it is minted as a
  // node like any other and the registry is asked whether it is installed.
  //
  // Only referenced targets get a node -- the plan's own selected carriers,
  // plus every carrier reachable by nesting from one (`referencedRepresentations`).
  // A carrier the program does not contain, referenced or not, is one nothing
  // can narrow to, and minting a node for it would claim a capability against
  // a carrier the program never touches.
  const referencedKeys = new Set(referenced.keys())
  for (const [sourceKey, representation] of referenced) {
    // `subsetNarrowingTargetsOf` draws every candidate straight from
    // `referenced`, so each one is trivially already a `referencedKeys`
    // member -- the filter below stays uniform across both sources rather
    // than special-casing the one that cannot fail it.
    for (const target of [...narrowingClosureOf(representation), ...subsetNarrowingTargetsOf(representation, referenced)]) {
      const targetKey = representationKey(target)
      if (!referencedKeys.has(targetKey)) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.narrowing(representation, target)
      // The same order `conversion/nodes.ts`'s `capabilityOf` asks in: an
      // installed atom, else the registry's static recipe, else never. A
      // `never` minted here is what `nodeFor` hands back for the pair, so a
      // pair the static recipe answers must be answered here too or the
      // eager graph would refuse what a late question would allow.
      const recipe = installed ? null : registry.staticRecipe(representation, target)
      nodes.set(id, {
        id,
        source: representation,
        target,
        capability: installed
          ? narrowingCapabilityFor(representation, target, installed)
          : recipe
            ? { kind: 'static', materializer: recipe }
            : { kind: 'never', reason: `no runtime narrowing is installed from ${sourceKey} to ${targetKey}` }
      })
    }
  }

  // An absent array proven present and then read as the interface that
  // extends it -- tsc's `createNodeArray(elements?: readonly T[])` after
  // `isNodeArray(elements)` -- lands on a referenced `array-object` whose only
  // difference from the payload is the extension, one C++ type either way.
  // Proposed here because neither closure above reaches it: the payload is
  // not that carrier, and the target is not a subset of any sum.
  const extendedArrayTargets = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'array-object' && one.extension !== null)
  for (const [sourceKey, source] of referenced) {
    if (source.kind !== 'optional' || source.payload.kind !== 'array-object') continue
    const payload = source.payload
    for (const [targetKey, target] of extendedArrayTargets) {
      if (target.kind !== 'array-object' || target.ownership !== payload.ownership) continue
      if (representationKey(target.element) !== representationKey(payload.element)) continue
      if (arrayExtensionKey(target.extension) === arrayExtensionKey(payload.extension)) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.narrowing(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // A sum arm holding a base-class Ref can narrow directly to a referenced
  // descendant after `instanceof`. Descendants cannot be enumerated from the
  // source carrier alone, so pair sums with the program's concrete class refs
  // just as the class-to-class loop below does.
  const descendantClassTargets = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'class-ref')
  for (const [sourceKey, source] of referenced) {
    if (source.kind !== 'optional' && source.kind !== 'tagged-union') continue
    for (const [targetKey, target] of descendantClassTargets) {
      if (!narrowingReachesTarget(source, target)) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.narrowing(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Widening stores, the mirror of the narrowing read above: `const x: boolean
  // | number = someBoolean` puts a plain `scalar(boolean)` where a
  // `TaggedUnion` is declared, and a control-flow merge does the identical
  // thing when its two branches arrive with different carriers and the plan
  // gives the merge itself the union. Gated strictly on `registry.widening`
  // returning a real pair -- unlike the narrowing loop above, which always
  // mints a node -- because an unregistered widening has no backend recipe at
  // all, not merely an unproven one; minting it anyway would let a program
  // certify on a backend that cannot spell the conversion it just claimed.
  for (const [targetKey, target] of referenced) {
    for (const source of wideningSourcesOf(target)) {
      const sourceKey = representationKey(source)
      if (!referencedKeys.has(sourceKey)) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // A sum source is not derivable from a sum target: the target describes its
  // own alternatives, while a source may keep an absence wrapper or a nested
  // tag around an otherwise matching value.  Ask the runtime only for those
  // explicit sum-to-sum pairs.  `nativeSumConversion` is deliberately stricter
  // than a structural fallback: every live source alternative must reach one
  // exact tag (or a proven class-base tag), so this never erases an array
  // element shape, an opaque native handle, or an unmatched scalar.
  const sumCarriers = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'optional' || one.kind === 'tagged-union')
  for (const [targetKey, target] of sumCarriers) {
    for (const [sourceKey, source] of sumCarriers) {
      if (sourceKey === targetKey) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Function declarations and closed families retain authentication metadata
  // that an evaluated dispatch does not carry, but all four carriers use the
  // same CallableObject when their ABI keys match exactly.  Index candidates
  // by that semantic ABI key rather than scanning every callable pair: no
  // parameter or result adaptation is licensed here.
  const callableSourcesByAbi = new Map<string, (readonly [string, Representation])[]>()
  for (const [sourceKey, source] of keyedDistinct(referenced.values())) {
    const abi = callableObjectAbiKey(source)
    if (abi === null) continue
    const members = callableSourcesByAbi.get(abi)
    if (members) members.push([sourceKey, source])
    else callableSourcesByAbi.set(abi, [[sourceKey, source]])
  }
  for (const [targetKey, target] of keyedDistinct(referenced.values())) {
    if (target.kind !== 'function-value-dispatch') continue
    for (const [sourceKey, source] of callableSourcesByAbi.get(abiKey(target.abi)) ?? []) {
      if (sourceKey === targetKey) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Boxing into `dynamic`: the one widening target `wideningSourcesOf` cannot
  // enumerate structurally. Everywhere else the function reads valid sources
  // straight off `target`'s own shape -- a tagged union's fixed arm list, an
  // optional's fixed payload -- but "everything this backend can box" is a
  // fact about each SOURCE's own kind, not something `target: { kind:
  // 'dynamic' }` states. So this asks every selected representation once,
  // gated the identical strict way widening already is: only a real backend
  // recipe (`registry.widening` recognizing the source's kind) mints a node.
  //
  // Enumerated from `referenced`, not from `plan.selected`, and this was the
  // one loop here that read the plan's TOP LEVEL only. A carrier that appears
  // solely NESTED inside another -- an ABI's result is the measured case: a
  // trap declared `get(...): unknown` puts `dynamic(declared-any-never-
  // narrowed)` in the callable's convention and nowhere else -- was never a
  // target, so `return <number>` into it refused for a capability the registry
  // was ready to install. Every sibling loop in this function already reads
  // `referenced` for exactly this reason.
  const referencedKeyed = keyedDistinct(referenced.values())
  const dynamicTargets = referencedKeyed.filter(([, target]) => target.kind === 'dynamic')
  for (const [targetKey, target] of dynamicTargets) {
    for (const [sourceKey, source] of referencedKeyed) {
      if (sourceKey === targetKey) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Conversion into a function IDENTITY: its own loop for the same reason the
  // boxing loop above has one. `callable-identity` states no ABI -- that is
  // the whole point of the carrier -- so it cannot name its own sources the
  // way `function-value-dispatch` names them by matching ABI key; "every
  // carrier this backend spells as a CallableObject" is a fact about each
  // SOURCE. `stackCrawlMark || assertIsDefined` (tsc's `debug.ts`, and the
  // largest single family in its self-compile) is the shape: the merge target
  // is the identity and the right arm is an ordinary concrete function.
  const identityTargets = referencedKeyed.filter(([, target]) => target.kind === 'callable-identity')
  for (const [targetKey, target] of identityTargets) {
    for (const [sourceKey, source] of referencedKeyed) {
      if (sourceKey === targetKey) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Class upcasts: a derived class-ref stored where a base class-ref is
  // declared. Its own loop for the same reason the boxing loop above has one
  // -- `wideningSourcesOf` reads valid sources off the TARGET's own shape, and
  // `class-ref(MongoError)` states nothing about which classes descend from
  // it; that is a fact about each SOURCE. So this asks every referenced pair
  // once and lets the registry's own heritage answer decide, gated the
  // identical strict way every widening is.
  //
  // `previousOperationError ?? new MongoRuntimeError(...)` (mongodb's
  // `execute_operation.ts`) is the shape: TypeScript reduces the merge to the
  // base `MongoError`, the freshly constructed arm carries the derived class,
  // and without this loop the two never meet and the merge refuses.
  const classRefs = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'class-ref')
  for (const [targetKey, target] of classRefs) {
    for (const [sourceKey, source] of classRefs) {
      if (sourceKey === targetKey) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      // Both directions, from one enumeration. Upcast (a derived class stored
      // where a base is declared) is a widening; DOWNCAST -- a base-declared
      // handle read at a descendant, which is what `instanceof` narrows -- is
      // a narrowing, and it needs exactly the same pair enumeration for
      // exactly the same reason the comment above gives: which classes descend
      // from `class-ref(Object3D)` is a fact about each other class, not
      // something the carrier states. Asking only `widening` here left
      // `if ( part instanceof Mesh )`'s own reads with no node at all.
      const installed = registry.widening(source, target) ?? registry.narrowing(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // The constructor-side mirror: a derived class's constructor stored where a
  // family naming it is declared. A target family lists its members but not
  // which referenced single-class families are among them, so the pairs are
  // composed here and the registry decides, like the class-ref loop above.
  const constructorFamilies = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'constructor-family')
  for (const [targetKey, target] of constructorFamilies) {
    if (target.kind !== 'constructor-family' || target.members.length < 2) continue
    for (const [sourceKey, source] of constructorFamilies) {
      if (sourceKey === targetKey || source.kind !== 'constructor-family' || source.members.length !== 1) continue
      if (!target.members.includes(source.members[0]!)) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // The same class upcast when the declared destination keeps absence or
  // another union arm around the base class. The target alone cannot enumerate
  // its derived sources, so compose the pair here from the same referenced
  // class set as the direct upcast loop above and let the backend registry
  // decide whether it has one unambiguous arm to construct.
  const classSumTargets = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'optional' || one.kind === 'tagged-union')
  for (const [targetKey, target] of classSumTargets) {
    for (const [sourceKey, source] of classRefs) {
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // A choice among generic functions (`generic-function-set`, model.ts): a
  // member's own name -- read as the closed callable its one instantiation
  // gave its cell -- into the one-member set it denotes, and a set into every
  // superset a merge or a store widens it into. Neither closure above knows
  // the kind, and the registry answers both pairs (`conversions.ts`'s
  // `genericFunctionSetPair`), so they are proposed here explicitly.
  const genericFunctionSets = keyedDistinct(referenced.values()).filter(([, one]) => one.kind === 'generic-function-set')
  for (const [targetKey, target] of genericFunctionSets) {
    if (target.kind !== 'generic-function-set') continue
    for (const [sourceKey, source] of referenced) {
      if (sourceKey === targetKey) continue
      const widens =
        source.kind === 'generic-function-set'
          ? source.members.every((member) => target.members.includes(member))
          : (source.kind === 'function' ||
              source.kind === 'function-family' ||
              source.kind === 'function-value-family' ||
              source.kind === 'function-value-dispatch') &&
            target.members.length === 1
      if (!widens) continue
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      const installed = registry.widening(source, target)
      if (!installed) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Union recasts: two tagged unions that carry the same member set at
  // different tag orders, which happens whenever a merge's two branches
  // arrive through independently-declared unions (`boolean | number` on one
  // arm, `number | boolean` on the other). Neither narrowing nor widening
  // covers it -- the source is not one arm of the target, and the target is
  // not one arm of the source -- so it is its own loop over every pair of
  // selected unions, gated the same strict way widening is.
  //
  // Records join the same loop, and for the same reason one level out: two
  // records declaring the same fields under two shape ids -- `Named & { age:
  // number }` against the literal that satisfies it -- are one shape spelled as
  // two structs, and neither is an arm of the other either.
  //
  // Dictionaries join too, one level further out: a record's closed field set
  // poured into a dictionary's open one is a third shape of the same recast --
  // `return {}` reaching a `Record<string, V>`-declared result is the concrete
  // case (`emit-narrowing.ts`'s `recordCastableToDictionary` is the one
  // authority for which pairs actually rebuild; every other pairing a
  // `dictionary` could sit in this loop as source or target for, `registry.
  // recasting` answers `null` for, exactly as it already does for a record and
  // a union that do not share arms).
  // `optional` joins the same loop for a fourth reason, narrower than the
  // other three: `gea::Optional<T>` carries a presence bit and nothing else --
  // `cppTypeOf` never reads `.absence` -- so two optionals over the identical
  // payload that disagree only on which falsy JS value means "empty"
  // (`string | null` widened into a `string | undefined` slot, DOM `Headers.
  // get`'s own `null` reaching a fetch-shaped API that promises `undefined`)
  // are the SAME C++ type under two representation identities, the identical
  // fact `record`/`dictionary` state about a closed shape poured into an open
  // one. `registry.recasting` only admits the pair when the PAYLOADS already
  // match exactly; a payload that itself needs converting is two obligations,
  // not one, and stays outside this loop.
  //
  // `array-object` joins for a fifth reason, on the target side only in
  // practice: an unannotated rest parameter is two views of one binding --
  // `restParameterArrayElementAt` (semantics/normalize/structural.ts) already
  // resolves the binding's OWN read-type to a real array, but the callable's
  // ABI still publishes the closed positional record it was derived from
  // (`records.ts` never wraps a non-required field, so the record can't even
  // state which trailing arg was omitted -- see recordCastableToArray's own
  // comment). Without `array-object` in this filter the loop never calls
  // `registry.recasting(record, array-object)` at all, no matter what that
  // predicate answers: the pair is filtered out before the call happens.
  const recastable = keyedDistinct(referenced.values()).filter(
    ([, one]) =>
      // `dynamic` joins for a sixth reason, and the narrowest of all: two
      // boxes that differ only in `reason` are the same `gea::Value` under two
      // representation identities, which is precisely what this loop is for.
      one.kind === 'dynamic' ||
      one.kind === 'tagged-union' ||
      one.kind === 'record' ||
      // An open structural record can satisfy a named open interface while
      // preserving the identical index sidecar. The target still has to prove
      // the fields and index carriers match in the runtime registry.
      one.kind === 'record-with-index' ||
      // `native-record-ref` joins on the TARGET side: it names a layout instead
      // of carrying one, so the pair `record -> native-record-ref` -- `return
      // options` out of a method declared to return a named overlapping shape,
      // which the mongodb driver is built out of -- was filtered out before
      // `registry.recasting` was ever asked what it thought.
      one.kind === 'native-record-ref' ||
      // A concrete generated class can be rebuilt as a structural interface
      // view. The registry proves its data fields and bound methods; including
      // the carrier here only makes that exact source/target pair visible.
      one.kind === 'class-ref' ||
      one.kind === 'dictionary' ||
      one.kind === 'optional' ||
      one.kind === 'array-object' ||
      // Promise state adoption converts the fulfillment payload while
      // preserving pending and rejected states. A String wrapper read as its
      // primitive value is the other source/target pair whose recipe is a
      // recast rather than a narrowing or a widening. The runtime registry
      // remains the authority for whether either exact pair is installed.
      one.kind === 'promise' ||
      one.kind === 'string'
  )
  // Which pairs already have a node, read off `nodes` once and keyed by
  // target, so the loop below never builds an id only to test it. The loop
  // is every ordered pair of `recastable` -- 10,447 carriers on TypeScript's
  // own compiler, 109 million pairs -- and a CPU profile of that stage put
  // 41% in this loop body itself, the concatenated id and its Map probe, and
  // a further 16% in the collector reclaiming those strings. An id is built
  // only for a pair the registry installs. Only a pair-shaped id counts: the
  // dynamic-materialization nodes above are keyed by their target alone, and
  // the loop would have asked about those pairs before.
  const sourcesWithNodeInto = new Map<string, Set<string>>()
  for (const node of nodes.values()) {
    const sourceKey = representationKey(node.source)
    const targetKey = representationKey(node.target)
    if (node.id !== `${sourceKey}->${targetKey}`) continue
    let sources = sourcesWithNodeInto.get(targetKey)
    if (!sources) {
      sources = new Set()
      sourcesWithNodeInto.set(targetKey, sources)
    }
    sources.add(sourceKey)
  }
  for (const [targetKey, target] of recastable) {
    const existing = sourcesWithNodeInto.get(targetKey)
    for (const [sourceKey, source] of recastable) {
      if (sourceKey === targetKey || existing?.has(sourceKey)) continue
      const installed = registry.recasting(source, target)
      if (!installed) continue
      const id = `${sourceKey}->${targetKey}`
      nodes.set(id, {
        id,
        source,
        target,
        capability: { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
      })
    }
  }

  // Dynamic reasons identify provenance, not distinct boxed ABIs. The generic
  // root above proves the declared-any source, but obligations name the
  // source's exact representation key. Every other selected dynamic source
  // therefore needs the same derived capability under its own key for every
  // referenced target. This is installation only: `deriveConversionCapability`
  // still decides whether the target is a checked extraction, a product/array
  // materialization, or a stated refusal. In particular, do not turn this
  // into an identity edge merely because both sources use gea::Value.
  for (const [sourceKey, source] of referenced) {
    if (sourceKey === genericDynamicKey || source.kind !== 'dynamic') continue
    for (const [targetKey, target] of referenced) {
      const id = `${sourceKey}->${targetKey}`
      if (nodes.has(id)) continue
      nodes.set(id, {
        id,
        source,
        target,
        capability: deriveConversionCapability(target, context)
      })
    }
  }

  // A graph whose recursive references never close is materializable in each
  // node taken alone and unrunnable taken together; the whole-graph check is
  // the only place that difference is visible.
  validateConversionGraph([...nodes.values()])
  return { nodes }
}
