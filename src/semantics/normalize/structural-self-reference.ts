import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralIndexShape, StructuralShape, TupleElement } from '../model/structural-types.js'

/**
 * Self-reference without a declared name.
 *
 * `structural.ts`'s anchor rule assumes every cycle in the type graph passes
 * through a declaration -- true for an interface or a class, and false for a
 * recursive *type alias*: `type IDBValidKey = number | string | Date |
 * BufferSource | IDBValidKey[]` (lib.dom.d.ts) is a union one of whose arms
 * mentions it, and a union interns by shape rather than anchoring, so the walk
 * re-enters it forever. The failure is a stack overflow, which says nothing
 * about the program and takes every other answer down with it.
 *
 * Self-reference is *detected*, not assumed: the first walk raises the signal
 * below when it re-enters a type it is already inside, and the retry anchors
 * first, exactly as a declared name does. So only a type proven self-referential
 * pays for an anchor, and every ordinary union keeps interning by shape --
 * which is what keeps two structurally identical unions one id.
 *
 * That covers a cycle the walk can SEE, because the same `ts.Type` object comes
 * back. `AliasRecurrence`, at the bottom of this file, covers the cycle it
 * cannot: a generic alias that re-instantiates to a fresh type at every level,
 * where re-entry is a fact about layout rather than about object identity. Both
 * end in the same place -- an anchor reserved for the outer occurrence, which
 * the inner one resolves to -- and only the test for "have I been here before"
 * differs.
 */

/** Raised when a walk re-enters the type it is already inside. Carries the type so the frame that owns it can tell its own re-entry from an inner one. */
export const selfReferentialSignal = (type: ts.Type): { readonly selfReferentialType: ts.Type } => ({ selfReferentialType: type })

export const isSelfReferentialSignal = (error: unknown): error is { readonly selfReferentialType: ts.Type } =>
  typeof error === 'object' && error !== null && 'selfReferentialType' in error

/**
 * The identity a self-referential type anchors under.
 *
 * Minted per checker type object -- the same identity the walk's `inProgress`
 * and `completed` maps are already keyed on -- rather than derived from the
 * alias's declaration: an alias with type arguments would need its arguments'
 * structural ids in its key, and computing those means walking back into the
 * very type the key exists to anchor. The cost is that two checker objects for
 * one alias would anchor twice; the checker hands back one object per alias
 * instantiation, so in practice they do not.
 */
export const selfReferentialKeyOf = (keys: Map<ts.Type, string>, type: ts.Type): string => {
  const existing = keys.get(type)
  if (existing !== undefined) return existing
  const key = `self-referential:${keys.size}`
  keys.set(type, key)
  return key
}

/**
 * The shape of a self-referential type, built once its anchor exists so the
 * mention of itself resolves to that anchor instead of recursing.
 *
 * The structural kinds that can close a cycle without a declared name: a
 * union, an intersection, a tuple, an array, a callable, and a bare
 * index-signature object. A declared name has its own anchor path and never
 * reaches here.
 */
export const selfReferentialShapeOf = (
  checker: ts.TypeChecker,
  type: ts.Type,
  typeOf: (type: ts.Type) => StructuralTypeId,
  tupleElementsOf: (reference: ts.TupleTypeReference) => readonly TupleElement[],
  indexesOf: (type: ts.Type) => readonly StructuralIndexShape[],
  callableShapeOf?: (type: ts.Type) => StructuralShape | null
): StructuralShape | null => {
  if (type.isUnion()) return { kind: 'union', members: type.types.map(typeOf) }
  // `declaration: null` on purpose. This builder answers the self-reference
  // walk, which asks only how a shape is composed; the branded-alias name is a
  // fact `structural.ts`'s own interning path carries, and inventing one here
  // would give the same type two identities depending on which walk reached it.
  // `resolved: null` -- this is the SELF-REFERENTIAL retry, which has no table
  // to intern a second shape into and is reached precisely because the walk is
  // already inside this type. `derive.ts` falls back to the member merge for a
  // shape interned without a reconciliation.
  if (type.isIntersection()) return { kind: 'intersection', members: type.types.map(typeOf), declaration: null, resolved: null }
  if (checker.isTupleType(type)) {
    const reference = type as ts.TupleTypeReference
    return { kind: 'tuple', elements: tupleElementsOf(reference), readonly: reference.target.readonly }
  }
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0]
    // `readonly` is the array-*like*-but-not-array case, which this branch has
    // already excluded, so it is settled false rather than re-tested.
    return element ? { kind: 'array', element: typeOf(element), readonly: false, extension: [] } : null
  }
  // A callable (a method's own function type) can end up the *outer* frame of
  // a walking collision purely by processing order -- the census does not
  // promise a method's own allocation runs after its enclosing object
  // literal's -- even though the object is what genuinely carries the cycle.
  // `callableShapeOf` gives it the same plain `signature` shape it would have
  // gotten via the ordinary call-signature branch; the object it references
  // as `this` is anchored separately, by `declaredAnchorOf`'s alias fallback
  // or the object-literal anchor in `structural.ts`.
  const callable = callableShapeOf ? callableShapeOf(type) : null
  if (callable) return callable
  // A DICTIONARY closes a cycle without a declared name too: hono's router is
  // `class Node { #children: Record<string, Node> }`, and `Record<string, V>`
  // is a homomorphic mapped-type instantiation whose own symbol answers the
  // anonymous `__type` of the `MappedTypeNode` rather than the
  // `TypeAliasDeclaration` -- so `declaredAnchorOf` returns null for it and
  // the retry lands here with no name to anchor under. It has an index and
  // that index's value is this very type.
  //
  // `members: []` is a FACT here, not a projection: this branch is taken only
  // when the type has no properties at all, which a homomorphic `Record<K,V>`
  // never does. An object that carries both named members and an index needs
  // `objectShapeOf`'s location-aware member walk, which this retry has no
  // access to -- so it keeps the refusal rather than interning a shape with
  // its members silently dropped.
  if (checker.getPropertiesOfType(type).length === 0) {
    const index = indexesOf(type)
    if (index.length > 0) return { kind: 'object', members: [], index, membersDropped: false }
  }
  return null
}

/**
 * Where a recursive type alias closes back on itself.
 *
 * A recursive conditional or mapped type alias instantiates into a FRESH
 * `ts.Type` at every level, so `structural.ts`'s cycle guards -- all keyed by
 * `ts.Type` object identity -- can never see one twice, and the walk does not
 * terminate on its own.
 *
 * mongodb's `Filter` is the concrete case, and it is worth reading in full
 * because it is the shape of the whole problem:
 *
 * ```ts
 * type Filter<T> = { [P in keyof WithId<T>]?: Condition<WithId<T>[P]> } & RootFilterOperators<WithId<T>>
 * interface RootFilterOperators<T> extends Document { $and?: Filter<T>[]; $nor?: Filter<T>[]; $or?: Filter<T>[] }
 * ```
 *
 * `Filter<T>` does not refer to `Filter<T>`. It refers to `Filter<WithId<T>>`,
 * whose `$and` refers to `Filter<WithId<WithId<T>>>`, forever. TypeScript mints
 * a new type for each -- measured on the mongodb driver: type#34381, #34389,
 * #34397, ... one per level, each argument a fresh `WithId` instantiation.
 *
 * Every one of those types has the same layout. The unfolding is infinite as a
 * TREE and finite as a GRAPH: one node whose `$and` field points back at that
 * same node. That is an ordinary recursive record, and the compiler already
 * carries one -- `native-record-ref`, a name plus a forward declaration, which
 * is what `representation/derive.ts` hands any record that re-enters itself.
 *
 * So the question this module answers is NOT "how deep may an alias go". It is
 * "has this instantiation already appeared", and the answer closes the loop.
 *
 * ⛔ This used to be a depth counter that refused at 16 levels. A counter
 * cannot distinguish the two cases that matter:
 *
 *   - REGULAR recursion (`Filter`): every level has the same layout, the graph
 *     is finite, and the right answer is to fold -- which is what `within`
 *     does now, typically at level 2.
 *   - IRREGULAR recursion (`type Nest<T> = { value: T; next: Nest<[T]> }`):
 *     `value` is `T`, then `[T]`, then `[[T]]`; no two levels share a layout,
 *     no finite carrier exists, and the right answer is to refuse.
 *
 * A counter answers neither. It stops at an arbitrary number in both cases and
 * reports "I stopped looking" as though it were a verdict -- and the number is
 * wrong in both directions at once, because the work between levels multiplies:
 * `Filter`'s three recursive fields made the SELECTED CARRIER for level 1
 * contain 3^15 copies of level 16, and `representationKey` overflowed V8's
 * 512 MB string limit (a `RangeError` out of `Array.join`) long before the
 * refusal at 16 could be reported. Raising the limit explodes; lowering it
 * refuses programs with a perfectly good finite layout.
 *
 * An alias re-entered through a non-equivalent instantiation has no stable
 * declaration/type identity to anchor. It is refused at that FIRST mismatched
 * back edge, rather than being unfolded some arbitrary number of times and
 * then cut. A finite native fixpoint has to close at an equivalent ancestor;
 * a different instantiation is a different C++ type equation.
 */
export interface AliasRecurrence<T> {
  /**
   * Walks `type`, folding to an equivalent ancestor instantiation of the same
   * alias when there is one.
   *
   * `fold` is given that ancestor, and is expected to resolve it to whatever
   * anchor the ancestor's own in-flight walk is building -- the caller owns
   * that, because reserving an anchor for a walk still on the stack is
   * `structural.ts`'s self-reference machinery, not this module's.
   *
   * `fold` is also the identity of the VIEW doing the walking: one closure per
   * specialization view, stable for that view's life. The stack is shared
   * across views (see `createAliasRecurrence`), so an ancestor may have been
   * pushed by another view, whose `inProgress`/`walking` maps are the only
   * ones that know its anchor. The fold therefore goes through the ancestor's
   * OWN entry's resolver, never the caller's -- asking the caller's view about
   * a type it never walked answered "already unwound" for every cross-view
   * back edge, which is how tsc's `sameMap`/`find` copies over a recursive
   * alias published unresolved bindings (31 rows on the self-compile).
   */
  readonly within: (type: ts.Type, walk: () => T, fold: (ancestor: ts.Type) => T, refuse: (reason: string) => T) => T
}

/**
 * Whether two instantiations of one alias stand for the same layout.
 *
 * Mutual assignability is TypeScript's own structural relation, and it is
 * already coinductive over recursive types -- which is exactly the decision
 * procedure needed here, computed by the one component that has the whole type
 * graph. Measured on mongodb: `Filter<WithId<Doc>>` against
 * `Filter<WithId<WithId<Doc>>>` answers `true` both ways in 32 ms cold and
 * ~0 ms after, because the checker memoizes its relation.
 *
 * ⛔ The `any`/`unknown` exclusions are not defensive noise. A top type is
 * mutually assignable to EVERYTHING, so `Box<any>` and `Box<string>` would
 * compare equal and folding them would merge a dynamic carrier into a string
 * one -- a silently wrong layout, which is worse than the refusal this replaces.
 * An argument that is a top type is therefore never foldable, and the backstop
 * catches the alias instead.
 */
const createEquivalence = (checker: ts.TypeChecker) => {
  const answers = new Map<string, boolean>()
  const isTopType = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  return (left: ts.Type, right: ts.Type): boolean => {
    // JSDoc typedef members can point back to the exact checker type object
    // whose declared anchor is being built. That is the strongest possible
    // equivalence: refusing it makes `Node[]` publish an unresolved element
    // beside the otherwise valid `Node` anchor. Fresh alias instantiations
    // still take the assignability path below.
    if (left === right) return true
    if (isTopType(left) || isTopType(right)) return false
    const leftArguments = left.aliasTypeArguments ?? []
    const rightArguments = right.aliasTypeArguments ?? []
    if (leftArguments.length !== rightArguments.length) return false
    if (leftArguments.some(isTopType) || rightArguments.some(isTopType)) return false
    const key = `${typeIdOf(left)}|${typeIdOf(right)}`
    const remembered = answers.get(key)
    if (remembered !== undefined) return remembered
    // Optimistic while it is being decided: the relation is coinductive, and a
    // re-entrant question about the same pair is the hypothesis, not a cycle to
    // break. The checker answers its own recursive comparisons the same way.
    answers.set(key, true)
    const decided =
      leftArguments.every((argument, position) => {
        const other = rightArguments[position]
        return other !== undefined && checker.isTypeAssignableTo(argument, other) && checker.isTypeAssignableTo(other, argument)
      }) &&
      checker.isTypeAssignableTo(left, right) &&
      checker.isTypeAssignableTo(right, left)
    answers.set(key, decided)
    return decided
  }
}

/** A type's checker-assigned id, which is stable within one program and is not on the public type. */
const typeIdOf = (type: ts.Type): number => (type as ts.Type & { id?: number }).id ?? -1

// A backstop, not the primary mechanism -- `guards` (shrink/grow via sub-term
// reachability) settles every case it has evidence for, at whatever depth.
// This only fires when NEITHER direction produced evidence, which every real
// finite chain measured against this file never does past a handful of
// levels (see the comment at its call site).
const aliasStackDepthLimit = 48

export const createAliasRecurrence = <T>(checker: ts.TypeChecker): AliasRecurrence<T> => {
  const equivalent = createEquivalence(checker)
  // ⛔ The stack MUST be shared across specialization views. `buildMapper`
  // builds one view per specialization path with its own guard state, and this
  // unfolding crosses views: a per-view stack sees depth 0 every lap and never
  // folds. That was measured on the counter this replaces -- a per-view version
  // of exactly that code left all 334 hono laps in place.
  //
  // Shared, but not view-blind. An OPEN instantiation -- one whose alias
  // arguments still mention a type parameter -- is the same checker object in
  // every view that walks it, laid out differently under each view's
  // bindings (`guards` below says why that is a schema, not a stage). Folding
  // it to another view's occurrence would hand a copy the open view's layout,
  // so for an open type only its own view's entries are consulted: the other
  // views' walks of that schema neither fold it nor guard it. A CLOSED
  // instantiation mentions no binding, lays out the same everywhere, and folds
  // to the nearest equivalent ancestor whichever view pushed it -- through
  // that entry's own resolver.
  const unfolding = new Map<ts.Symbol, { readonly type: ts.Type; readonly fold: (ancestor: ts.Type) => T }[]>()
  return {
    within: (type, walk, fold, refuse) => {
      const alias = type.aliasSymbol
      if (alias === undefined) return walk()
      const ancestors = unfolding.get(alias) ?? []
      const open = mentionsTypeParameter(type)
      const visible = open ? ancestors.filter((entry) => entry.fold === fold) : ancestors
      // Innermost first: the nearest equivalent ancestor is the tightest knot,
      // and folding to it keeps the cycle as small as the type really is.
      for (let position = visible.length - 1; position >= 0; position -= 1) {
        const ancestor = visible[position]
        if (ancestor !== undefined && equivalent(ancestor.type, type)) return ancestor.fold(ancestor.type)
      }
      if (visible.some((ancestor) => guards(ancestor.type, type)))
        return refuse(
          `type alias ${alias.name} re-entered with no equivalent active instantiation: ` +
            'the recursive equation has no stable declaration/type identity for a finite native carrier'
        )
      // ⛔ `guards` needs POSITIVE evidence of growth to refuse (`grewFrom`), so a
      // pair that grows through a mechanism the sub-term walk cannot see at all --
      // measured on `type Inc<N extends number> = ...` arithmetic, where each
      // step's literal-number argument carries no `aliasTypeArguments`/
      // `typeArguments` connecting it to the last -- answers `false` in both
      // directions and `guards` never fires. Confirmed empirically: a hand-built
      // `Count<N> = { next: Count<Inc<N>> }` walked 200+ levels with this file's
      // sub-term measure and never refused, where the pre-`grewFrom` formula
      // refused at the first re-entry. Every REAL finite chain in this file's own
      // regression history closes far shallower than this -- mongodb's `Filter`
      // folds by level 2, hono's `Record` siblings never exceed depth 2 -- so a
      // stack this deep for one alias symbol is never a legitimate finite program;
      // it is exactly the growth `guards` was supposed to catch and could not see.
      // Refusing here trades a rare, generous-margin false refusal for turning an
      // unbounded walk back into the diagnostic this file exists to produce.
      if (ancestors.length >= aliasStackDepthLimit)
        return refuse(
          `type alias ${alias.name} re-entered ${ancestors.length} levels deep with no growth the sub-term measure could ` +
            'see in either direction: the recursive equation has no stable declaration/type identity for a finite native carrier'
        )
      ancestors.push({ type, fold })
      unfolding.set(alias, ancestors)
      try {
        return walk()
      } finally {
        ancestors.pop()
        if (ancestors.length === 0) unfolding.delete(alias)
      }
    }
  }
}

/**
 * Whether `ancestor` is a back edge for `type`, or merely the same declaration
 * seen through a different specialization view.
 *
 * ⛔ A walk in progress over an OPEN instantiation -- one whose alias arguments
 * still mention a type parameter -- is a schema, not a stage of an unfolding.
 * Monomorphization forks the walk per copy while the open walk is still on the
 * stack, so a copy that substitutes `T := number` reaches `Same<number>` under
 * an active `Same<T>`. That is one substitution, not recursion, and refusing it
 * left tsc's `contains`/`binarySearch` family (and every `EqualityComparer`,
 * `Comparer` and `Transformer` parameter behind it) with an unresolved carrier.
 *
 * Termination still holds: the admitted closed instantiation is pushed, and a
 * closed ancestor guards everything under it -- so `R<T>` may admit `R<number>`
 * once, and `R<number[]>` beneath that is refused as before.
 *
 * ⛔ The second admission is a DESCENT: an instantiation whose every alias
 * argument is a proper sub-term of the ancestor's. `Record<string,
 * Record<string, H[]>>` re-enters `Record` at `Record<string, H[]>`, and both
 * are open, so the rule above alone refuses it -- yet the type is plainly
 * finite, and nothing about it is recursion. That single refusal was 255 of
 * hono-hello's 487 roots: every one of `RegExpRouter`'s
 * `Record<string, Record<string, HandlerWithMetadata<T>[]>>` fields, and every
 * obligation minted off the `dictionary(string, unresolved, shared-refcount)`
 * they produced.
 *
 * Descent is what bounds it, and it bounds it for the same reason a structural
 * recursion does: the argument tuple strictly shrinks along the chain, and a
 * type's sub-term graph is finite, so no infinite descending chain exists. An
 * alias that GROWS its argument -- `type R<T> = { next: R<T[]> }` -- is
 * untouched: `T[]` is not a sub-term of `T`, so it is refused exactly as
 * before.
 *
 * ⛔ A re-entry at an UNRELATED argument -- neither a sub-term of the
 * ancestor's nor a super-term of it -- is not a back edge of this alias's own
 * unfolding at all, and refusing it was hono's `Node<T>`: walking
 * `#children: Record<string, Node<T>>` unfolds the value `Node<T>`, which is
 * a DECLARED class reached through its own anchor, and that class's member
 * census incidentally revisits `#methods: Record<string, HandlerSet<T>>[]`
 * -- a second, sibling `Record` instantiation nested on the stack purely
 * because the class's own census happened to run underneath, not because
 * `Record`'s definition refers to itself again. `Node<T>` and `HandlerSet<T>`
 * share no sub-term relationship in either direction: the pair is not
 * growing (measured on mongodb's `Filter`, `descends(type, ancestor)` is
 * true there -- `WithId<T>` unfolds *from* `T`) and not shrinking (`descends`
 * above is false). It is two unconnected instantiations that merely share a
 * call stack, and `HandlerSet<T>` does not itself recur into `Record` or
 * `Node`, so admitting it is finite by construction: this was 22 of
 * hono-hello's roots at lines 35/39/76/94/95 of `node.ts`.
 *
 * Requiring GROWTH -- `descends(type, ancestor)`, the same sub-term measure
 * with the pair reversed -- keeps refusing every case the file's own
 * regression history cares about (mongodb's `Filter<T>` -> `Filter<WithId<T>>`
 * still growing, still refused until the fold catches an equivalent ancestor)
 * while admitting a re-entry that is simply unrelated to the ancestor it
 * happened to be nested under.
 */
const guards = (ancestor: ts.Type, type: ts.Type): boolean =>
  !(mentionsTypeParameter(ancestor) && !mentionsTypeParameter(type)) && !descends(ancestor, type) && grewFrom(ancestor, type)

/**
 * Whether every alias argument of `type` is a PROPER sub-term of `ancestor`'s
 * alias arguments -- the measure that makes an open re-entry finite.
 *
 * Proper: the walk seeds from the ancestor's arguments' own children, never the
 * arguments themselves, so `R<A, B>` under `R<A, B>` does not read as a descent
 * (that pair is equivalent, and the fold above has already claimed it).
 *
 * Identity, not assignability. Two spellings of one argument are the same
 * checker type object when they are the same type, and a structural comparison
 * here would be both slower and looser than the measure needs: a sub-term
 * relation that admitted an equal-but-not-identical argument would admit a
 * chain that does not shrink.
 */
const subtermReach = (ancestor: ts.Type, type: ts.Type): 'descends' | 'no' | 'unseen' => {
  const descendants = type.aliasTypeArguments ?? []
  const ancestors = ancestor.aliasTypeArguments ?? []
  // Nothing to compare is not the same answer as "compared, and it does not
  // descend": `guards` reads the two differently, so say which one this is.
  if (descendants.length === 0 || ancestors.length === 0) return 'unseen'
  // The same bounds `mentionsTypeParameter` uses, and for the same reason: a
  // type argument graph can be cyclic. Past the bound the walk has stopped
  // seeing, and a truncated `reachable` can miss a sub-term that is really
  // there -- so saturation is reported as `unseen`, never as `no`.
  const budget = 4000
  let truncated = false
  const reachable = new Set<ts.Type>()
  const collect = (argument: ts.Type, depth: number): void => {
    if (reachable.has(argument)) return
    if (depth > 6 || reachable.size >= budget) {
      truncated = true
      return
    }
    reachable.add(argument)
    if (argument.isUnionOrIntersection()) for (const member of argument.types) collect(member, depth + 1)
    const reference = argument as ts.TypeReference
    for (const nested of reference.aliasTypeArguments ?? reference.typeArguments ?? []) collect(nested, depth + 1)
  }
  for (const argument of ancestors) {
    if (argument.isUnionOrIntersection()) for (const member of argument.types) collect(member, 1)
    const reference = argument as ts.TypeReference
    for (const nested of reference.aliasTypeArguments ?? reference.typeArguments ?? []) collect(nested, 1)
  }
  if (descendants.every((argument) => reachable.has(argument))) return 'descends'
  return truncated ? 'unseen' : 'no'
}

const descends = (ancestor: ts.Type, type: ts.Type): boolean => subtermReach(ancestor, type) === 'descends'

/**
 * Whether `type` re-enters the alias having GROWN out of `ancestor` -- the
 * ancestor's own arguments reappearing as sub-terms of the new ones, which is
 * the shape that unfolds without bound (`Filter<T>` -> `Filter<WithId<T>>`).
 *
 * Fail-closed, and that is the whole reason this is not just
 * `descends(type, ancestor)`. The measure has two blind spots -- an alias with
 * no arguments to compare, and a sub-term walk that hit its bound -- and in
 * both the honest answer is "cannot see". While growth was not part of the
 * question those answered `false` and the refusal stood anyway; as a
 * REQUIREMENT for refusing, a `false` there would clear it instead, turning a
 * diagnostic into an unbounded walk. So both answer true here.
 */
const grewFrom = (ancestor: ts.Type, type: ts.Type): boolean => subtermReach(type, ancestor) !== 'no'

/**
 * Conservative: an argument this cannot see through (a bare object literal type
 * mentioning `T`) reads as closed, which keeps the pre-existing refusal rather
 * than admitting a re-entry whose finiteness was never established.
 */
const mentionsTypeParameter = (type: ts.Type): boolean => {
  const mentions = (argument: ts.Type, depth: number): boolean => {
    if ((argument.flags & ts.TypeFlags.Instantiable) !== 0) return true
    // A type argument graph can be cyclic; the answer past a few levels is
    // "cannot see", which reads as closed and keeps the existing refusal.
    if (depth > 6) return false
    if (argument.isUnionOrIntersection()) return argument.types.some((member) => mentions(member, depth + 1))
    const reference = argument as ts.TypeReference
    return (reference.aliasTypeArguments ?? reference.typeArguments ?? []).some((nested) => mentions(nested, depth + 1))
  }
  return (type.aliasTypeArguments ?? []).some((argument) => mentions(argument, 0))
}

/**
 * The anchor key of a self-referential type whose shape cannot depend on
 * the view it is walked in -- it mentions no type parameter a function or
 * class declaration binds -- so every specialization view closes the cycle
 * at ONE anchor. `null` for a type a view could shape differently, which
 * keeps its per-view key. One instance serves every view of a mapper: the
 * ordinal names the checker's type object compilation-wide, where the
 * per-view `selfReferentialKeyOf` ordinal would collide across views.
 *
 * Why it exists: `type State = <S, R>(m: Machine<S, R>, stack: State[], ...)
 * => number` entered from `stateStack: State[]` in three generic functions
 * minted one `State[]` per copy -- five ids for one array -- and a callable
 * read out of one copy's cell could not enter another's slot.
 */
export const createViewIndependentRecurrence = (checker: ts.TypeChecker): ((type: ts.Type) => string | null) => {
  const keys = new Map<ts.Type, string | null>()
  // A signature written as a TYPE (`(x: T) => T` in an alias, an interface
  // method) binds its own parameters; only a declaration with a body, or a
  // class, is a specialization the view can copy.
  const viewBinds = (owner: ts.Node): boolean =>
    ts.isClassLike(owner) ||
    (ts.isFunctionLike(owner) &&
      !ts.isFunctionTypeNode(owner) &&
      !ts.isConstructorTypeNode(owner) &&
      !ts.isMethodSignature(owner) &&
      !ts.isCallSignatureDeclaration(owner) &&
      !ts.isConstructSignatureDeclaration(owner) &&
      !ts.isIndexSignatureDeclaration(owner))
  // A bound on the walk: past it the answer is the conservative one (keep the
  // per-view key), so a lib.dom-sized type costs nothing more than before.
  const budget = 4000
  const viewDependent = (type: ts.Type, seen: Set<ts.Type>): boolean => {
    if (seen.has(type)) return false
    if (seen.size >= budget) return true
    seen.add(type)
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const owner = type.getSymbol()?.declarations?.[0]?.parent
      return owner !== undefined && viewBinds(owner)
    }
    // The other instantiable forms, each through the types it is built from.
    if ((type.flags & ts.TypeFlags.Conditional) !== 0) {
      const conditional = type as ts.ConditionalType
      if (viewDependent(conditional.checkType, seen) || viewDependent(conditional.extendsType, seen)) return true
      return (type.aliasTypeArguments ?? []).some((argument) => viewDependent(argument, seen))
    }
    if ((type.flags & ts.TypeFlags.IndexedAccess) !== 0) {
      const access = type as ts.IndexedAccessType
      return viewDependent(access.objectType, seen) || viewDependent(access.indexType, seen)
    }
    if ((type.flags & ts.TypeFlags.Index) !== 0) return viewDependent((type as ts.IndexType).type, seen)
    if ((type.flags & ts.TypeFlags.Substitution) !== 0) return viewDependent((type as ts.SubstitutionType).baseType, seen)
    if ((type.flags & ts.TypeFlags.TemplateLiteral) !== 0) {
      return (type as ts.TemplateLiteralType).types.some((member) => viewDependent(member, seen))
    }
    if ((type.flags & ts.TypeFlags.StringMapping) !== 0) return viewDependent((type as ts.StringMappingType).type, seen)
    if ((type.flags & ts.TypeFlags.UnionOrIntersection) !== 0) {
      return (type as ts.UnionOrIntersectionType).types.some((member) => viewDependent(member, seen))
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return false
    if ((type.aliasTypeArguments ?? []).some((argument) => viewDependent(argument, seen))) return true
    const object = type as ts.ObjectType
    if ((object.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      // An instantiation of a declared generic: everything a view could
      // change is in the arguments, and the members are the declaration's
      // own. Following them instead never terminates -- `Array<T>.concat`
      // takes `ConcatArray<T>[]`, whose `concat` takes
      // `ConcatArray<ConcatArray<T>>[]`, a fresh instantiation every step.
      return checker.getTypeArguments(object as ts.TypeReference).some((argument) => viewDependent(argument, seen))
    }
    if ((object.objectFlags & ts.ObjectFlags.Mapped) !== 0) {
      const mapped = type as ts.Type & {
        readonly constraintType?: ts.Type
        readonly templateType?: ts.Type
        readonly modifiersType?: ts.Type
      }
      return [mapped.constraintType, mapped.templateType, mapped.modifiersType].some(
        (part) => part !== undefined && viewDependent(part, seen)
      )
    }
    // A class or interface declaration reached as itself binds its own
    // parameters; only an anonymous literal (a function type, an object
    // type) carries members written in terms of an enclosing declaration's.
    if ((object.objectFlags & ts.ObjectFlags.Anonymous) === 0) return false
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      if (signature.parameters.some((parameter) => viewDependent(checker.getTypeOfSymbol(parameter), seen))) return true
      if (viewDependent(signature.getReturnType(), seen)) return true
    }
    if (checker.getIndexInfosOfType(type).some((index) => viewDependent(index.type, seen))) return true
    return checker.getPropertiesOfType(type).some((property) => viewDependent(checker.getTypeOfSymbol(property), seen))
  }
  return (type) => {
    const known = keys.get(type)
    if (known !== undefined) return known
    const key = viewDependent(type, new Set()) ? null : `view-independent:${keys.size}`
    keys.set(type, key)
    return key
  }
}
