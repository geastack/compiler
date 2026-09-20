import ts from 'typescript'
import type { StructuralTypeId } from '../../../identity/ids.js'
import type { ProducerContext } from '../producer-context.js'
import { physicalGeneratorOverloadReturnOf } from '../physical-overload-result.js'

/**
 * What an iterable yields, read out of the checker's own declared protocol.
 *
 * `TypeChecker` has no public `getIteratorYieldType`, which is why this walk
 * exists -- but the walk is not a guess standing in for one. Every step below
 * reads a declaration the program (or the standard library) actually wrote, in
 * the order ECMA-262 7.4.2 `GetIterator` / 7.4.3 `IteratorNext` reads them:
 *
 *   1. `@@iterator` on the source
 *   2. the iterator object its call returns
 *   3. `next` on that object
 *   4. the `IteratorResult` its call returns
 *   5. that result's `value`, taken from the YIELD arm only
 *
 * Step 5 is the one that has to be spelled out. `IteratorResult<T, TReturn>` is
 * `IteratorYieldResult<T> | IteratorReturnResult<TReturn>`, discriminated by
 * `done: false` against `done: true`, so the naive answer -- the whole union's
 * `value` -- is `T | TReturn`, which for every standard collection is `T |
 * undefined`. That extra `undefined` is the *return* value's type and is never
 * observed by a consumer: `for`-`of`, spread and `yield*` all stop at the first
 * result whose `done` is true and never read its `value` (ECMA-262 7.4.6
 * `IteratorStep` returns `false` for it). Carrying it would make every
 * `for (const x of set)` bind an optional the program can never see absent --
 * an `undefined` invented here, not one the source declared. So the return arm
 * is dropped, exactly as the checker's own `getIteratorYieldType` drops it.
 *
 * `null` means the source states no iterator protocol this walk can follow, and
 * the caller keeps its own honest `unresolved`. It is never `any`: claiming the
 * checker typed something it did not is the failure this whole layer is built
 * to avoid.
 */

/**
 * Which well-known iteration symbol a walk is following.
 *
 * `for await` reads `[Symbol.asyncIterator]` FIRST and falls back to
 * `[Symbol.iterator]` (ECMA-262 14.7.5.7 GetIterator with hint `async`, which
 * wraps a sync iterator in CreateAsyncFromSyncIterator) -- so the two are one
 * ordered question, not two independent lookups, and the caller asks it once.
 */
type IterationSymbol = 'iterator' | 'asyncIterator'

/** Which iteration a caller is following -- `for`-`of` and spread are `sync`, `for await` is `async`. */
export type IterationProtocol = 'sync' | 'async'

/**
 * Whether a member is `[Symbol.iterator]` / `[Symbol.asyncIterator]`.
 *
 * The escaped name of a well-known-symbol member is `"__@" + name` optionally
 * followed by `"@" + the symbol's own declaration id` -- `__@iterator@11` on
 * the TypeScript this compiler builds against, bare `__@iterator` on older
 * ones. Both spellings are accepted rather than one, because the id half is a
 * per-program number with no meaning here and pinning it would silently stop
 * matching on a library upgrade. The two names never collide with each other:
 * the prefix tested includes the separator, so `__@asyncIterator@11` is not a
 * `__@iterator@...`.
 */
const isIterationMember = (symbol: ts.Symbol, wellKnown: IterationSymbol): boolean => {
  const name = String(symbol.escapedName)
  return name === `__@${wellKnown}` || name.startsWith(`__@${wellKnown}@`)
}

/** Every constituent of a union, or the type itself when it is not one. */
const constituentsOf = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types : [type])

/**
 * `source`'s own constituents with `undefined`/`null` dropped, or every
 * constituent when `source` is entirely nullish.
 *
 * `ts.Type#getProperties()` on a UNION answers with the properties held in
 * COMMON across every constituent -- documented `ts.Type` behavior, not a gap
 * this file introduces. `undefined` and `null` carry no properties at all, so
 * that intersection is EMPTY for any `T | undefined`, and `[Symbol.iterator]`
 * disappears even though `T` alone declares one. A `for`-`of` never actually
 * steps the `undefined` arm (stepping it throws before this compiler runs at
 * all -- the same runtime fact this file's own module comment already reasons
 * from for the RETURN arm of `IteratorResult`), so the protocol query below is
 * answered from the arms that can genuinely be iterated.
 */
const iterableConstituentsOf = (source: ts.Type): readonly ts.Type[] => {
  const nonNullish = constituentsOf(source).filter(
    (constituent) => (constituent.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0
  )
  return nonNullish.length > 0 ? nonNullish : constituentsOf(source)
}

/**
 * Every iterable constituent's OWN `[Symbol.iterator]` member, or `null` when
 * any one of them declares none.
 *
 * All-or-nothing, deliberately: a source where only SOME arms are iterable is
 * a real disagreement (this value is not unconditionally iterable), the same
 * refusal a single non-iterable type already produced before unions were
 * considered at all here -- never a guess at which arm the program meant.
 */
const iteratorMethodSymbolsOf = (source: ts.Type, protocol: IterationProtocol): readonly ts.Symbol[] | null => {
  const methods: ts.Symbol[] = []
  for (const constituent of iterableConstituentsOf(source)) {
    const properties = constituent.getProperties()
    // `async` looks for `[Symbol.asyncIterator]` first and accepts a plain
    // `[Symbol.iterator]` after it -- ECMA-262 14.7.5.7's own order, where a
    // sync iterable reached by `for await` is wrapped rather than rejected.
    // `sync` never accepts the async one: `for`-`of` over an async iterable is
    // a TypeScript error, not something to paper over here.
    const method =
      protocol === 'async'
        ? (properties.find((property) => isIterationMember(property, 'asyncIterator')) ??
          properties.find((property) => isIterationMember(property, 'iterator')))
        : properties.find((property) => isIterationMember(property, 'iterator'))
    if (!method) return null
    methods.push(method)
  }
  return methods
}

/**
 * The `[Symbol.iterator]` member a source's own type declares, or `null` when
 * it declares none (on `source` itself, or -- see `iterableConstituentsOf` --
 * on any of its non-nullish union arms) -- the same lookup
 * `iteratorYieldStructuralType` below performs to type what iterating
 * `source` yields, exported so `producers/protocol.ts` can resolve the SAME
 * member's property-key text for the general protocol's `get-method` step.
 * One lookup, cited by both, so the step that types the element and the step
 * that names the member to call can never disagree about which member either
 * one means, OR about whether a member exists at all: both go through
 * `iteratorMethodSymbolsOf`'s same all-or-nothing union rule. A well-known
 * symbol's key text is the same regardless of which constituent declares it
 * (`Symbol.iterator` names one property, not one per class), so the first
 * found is as good a representative as any for that purpose.
 */
export const iteratorMethodSymbolOf = (source: ts.Type, protocol: IterationProtocol = 'sync'): ts.Symbol | null =>
  iteratorMethodSymbolsOf(source, protocol)?.[0] ?? null

// STATED, not held: a `ts.Signature`'s own `getReturnType()` on a signature
// already resolved off a concrete member (`[Symbol.iterator]`/`next`) --
// there is no node here for a census to have bound evidence to, and no
// `ts.TypeChecker` call to route through one either.
/** The return types of every call signature a type carries, across all its constituents. */
const callResultsOf = (type: ts.Type): readonly ts.Type[] =>
  constituentsOf(type).flatMap((constituent) => constituent.getCallSignatures().map((signature) => signature.getReturnType()))

/**
 * The iterator objects `source`'s own `[Symbol.iterator]`(s) return when
 * called -- the RECORD ECMA-262 7.4.2 `GetIterator` hands back, before
 * anything downstream asks what iterating it yields. `null` under the same
 * all-or-nothing rule `iteratorMethodSymbolsOf` states: a source where only
 * some union arms are iterable names no single answer.
 *
 * Exported so `producers/protocol.ts` can ask what real structural type a
 * resolved `[Symbol.iterator]` method actually returns -- the same lookup
 * `iteratorYieldStructuralType` below performs on its way to an ELEMENT type,
 * factored out here rather than left for `protocol.ts` to re-walk
 * independently: the step that types what a `for`-`of` yields and the step
 * that types what calling `[Symbol.iterator]()` itself produces must resolve
 * to the same method, or a generator-returning `[Symbol.iterator]()` and the
 * element type computed for it could name two different generators.
 */
export const iteratorRecordTypesOf = (
  context: ProducerContext,
  source: ts.Type,
  at: ts.Node,
  protocol: IterationProtocol = 'sync'
): readonly ts.Type[] | null => {
  const methods = iteratorMethodSymbolsOf(source, protocol)
  if (!methods) return null
  // STATED, not held: `method` is a resolved member symbol on `source`
  // (already the census-corrected receiver -- `producers/protocol.ts`'s own
  // callers of this function read `source` through `context.types.rawTypeAt`),
  // so its own callable type is a structural fact about that receiver's
  // declared shape, not a program binding a census would improve further.
  // Deliberately NOT routed through `context.returns` (the optional return
  // census reachable off `context`): that census answers for a function-like
  // DECLARATION or the call/`new` naming it, and using it here without the
  // same checker-first, census-only-as-fallback reconciliation
  // `producers/invocations.ts` built for its own `returnType` (see that
  // file's `censusReturn`/`siteReturn` comment) risks introducing exactly the
  // "two authorities disagree" class that reconciliation exists to prevent,
  // for a narrow case (a hand-rolled iterator's own return type) with no
  // measured evidence it matters.
  return methods.flatMap((method) => {
    // An OVERLOADED generator member is the one case where the symbol's own
    // callable type cannot answer this: TypeScript shows the bodiless
    // signatures and never the implementation, so
    // `*[Symbol.iterator](): Generator<T>` behind an `(): IterableIterator<T>`
    // overload reads back as the interface -- and `protocol.ts`'s
    // `generatorRecordTypeOf` then publishes the synthetic `{ next() }` record
    // for a method that physically returns the native cursor. See
    // `physicalGeneratorOverloadReturnOf`.
    const physical = physicalGeneratorOverloadReturnOf(context.checker, method.getDeclarations() ?? [])
    return physical ? [physical] : callResultsOf(context.checker.getTypeOfSymbolAtLocation(method, at))
  })
}

/**
 * Whether an `IteratorResult` constituent is the RETURN arm -- the one whose
 * `done` is the literal `true`.
 *
 * Only an exact `true` literal is dropped. A result object that declares `done:
 * boolean` (the hand-written `{ value: T; done: boolean }` shape, which is what
 * a program-defined iterator most often writes) is not discriminated at all, so
 * it is a yield arm as much as a return arm and its `value` is genuinely what
 * the loop sees.
 *
 * `typeToString` decides which of the two boolean literals this is, and that is
 * a legitimate use of it rather than the forbidden one: the ban elsewhere in
 * this layer is on using a display string as type IDENTITY (two unrelated
 * anonymous objects print alike). Here the type is already known to be one of
 * exactly two intrinsics, `true` and `false`, whose renderings are their own
 * intrinsic names -- there is no third value for it to collide with, and no
 * public accessor for that name other than this one.
 */
const isIteratorReturnArm = (checker: ts.TypeChecker, arm: ts.Type, at: ts.Node): boolean => {
  const done = arm.getProperty('done')
  if (!done) return false
  // STATED: `arm` is one constituent of an already-resolved `IteratorResult`
  // (a call's own return type -- `next()`), and `done`'s own type is a
  // structural fact of that record, not a program binding. No `context` is
  // even threaded to this helper (it takes a bare `checker`), which matches:
  // there is nothing here a producer census answers.
  const doneType = checker.getTypeOfSymbolAtLocation(done, at)
  return (doneType.flags & ts.TypeFlags.BooleanLiteral) !== 0 && checker.typeToString(doneType) === 'true'
}

/** The `value` types of every yield arm of one `IteratorResult`. */
// STATED, same reasoning as `isIteratorReturnArm` just above: `value` is a
// member of an already-resolved `IteratorResult` arm, not a program binding.
const yieldValuesOf = (checker: ts.TypeChecker, result: ts.Type, at: ts.Node): readonly ts.Type[] =>
  constituentsOf(result).flatMap((arm) => {
    if (isIteratorReturnArm(checker, arm, at)) return []
    const value = arm.getProperty('value')
    return value ? [checker.getTypeOfSymbolAtLocation(value, at)] : []
  })

/**
 * The structural type an iteration over `source` yields, or `null` when the
 * source declares no iterator protocol this can follow.
 *
 * `at` is the iterated expression itself: `getTypeOfSymbolAtLocation` resolves
 * a member's type in a scope, and the scope that matters is the one the
 * iteration is written in.
 *
 * The union at the end is built by interning each arm and asking the structural
 * table for their union, rather than by asking the checker to union the
 * `ts.Type`s -- there is no public API for the latter, and the table's own
 * union is the same answer every other multi-arm producer in this layer builds.
 *
 * `iteratorYieldTypesOf` is the checker-level walk underneath it, exported
 * for the local census (`local-bindings.ts`), which types a pattern's read
 * of a non-array iterable (`var [a, b] = g()`) with no `ProducerContext` in
 * hand: the same five steps, answered as `ts.Type`s, so the census and the
 * producer can never disagree about what one source yields.
 */
export const iteratorYieldTypesOf = (
  checker: ts.TypeChecker,
  source: ts.Type,
  at: ts.Node,
  protocol: IterationProtocol = 'sync'
): readonly ts.Type[] | null => {
  const methods = iteratorMethodSymbolsOf(source, protocol)
  if (!methods) return null
  const values: ts.Type[] = []
  for (const method of methods) {
    for (const iterator of callResultsOf(checker.getTypeOfSymbolAtLocation(method, at))) {
      for (const constituent of constituentsOf(iterator)) {
        const next = constituent.getProperty('next')
        if (!next) continue
        // STATED, same boundary `iteratorRecordTypesOf` above documents: `next`
        // is a resolved member of an already-census-corrected iterator record.
        for (const result of callResultsOf(checker.getTypeOfSymbolAtLocation(next, at))) {
          // An async iterator's `next()` returns `Promise<IteratorResult<T>>`
          // (ECMA-262 27.1.3), so the record to read `value`/`done` off is the
          // AWAITED one. `getAwaitedType` is the checker's own answer to exactly
          // that -- the same one it uses to type an `await` expression -- and it
          // answers the type itself for a non-thenable, which is what makes this
          // safe to apply to the sync fallback arm too.
          const record = protocol === 'async' ? (checker.getAwaitedType(result) ?? result) : result
          values.push(...yieldValuesOf(checker, record, at))
        }
      }
    }
  }
  return values.length === 0 ? null : values
}

export const iteratorYieldStructuralType = (
  context: ProducerContext,
  source: ts.Type,
  at: ts.Node,
  protocol: IterationProtocol = 'sync'
): StructuralTypeId | null => {
  // Every non-nullish arm's OWN `[Symbol.iterator]` -- not `source`'s
  // (possibly empty, see `iterableConstituentsOf`) -- so a `Set<T> | Map<K,
  // V>`-shaped union still gathers each side's own iterator, exactly as it
  // did before unions with an absent arm were considered here at all.
  const values = iteratorYieldTypesOf(context.checker, source, at, protocol)
  if (!values) return null
  const members = values.map((value) => context.types.typeOf(value))
  const first = members[0]
  if (members.length === 1 && first !== undefined) return first
  return context.table.intern({ kind: 'union', members })
}
