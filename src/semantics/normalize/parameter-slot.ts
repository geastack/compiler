import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import { impliedPatternParameterOf, isUnusableEvidence, widestOf, withoutUndefinedMember } from './derived-expression-type.js'
import type { ParameterBindingCensus } from './parameter-bindings.js'
import type { IdentityTable } from './identities.js'

/** The three declaration facts that decide whether a slot has to encode omission. */
export interface ParameterSlotFlags {
  readonly optional: boolean
  readonly rest: boolean
  readonly hasInitializer: boolean
}

/**
 * What an UNANNOTATED rest parameter's checker-inferred type actually is, when
 * that type is an open-arity array rather than the closed tuple it might look
 * like at first read.
 *
 * `fetch: (request, Env?, executionCtx?) => ... = (request, ...rest) => {...}`
 * -- hono's own `Hono.fetch` -- is the concrete case this exists for: the
 * arrow function's declared type comes from the field it initializes, whose
 * signature has THREE named parameters and no rest at all. TypeScript's
 * contextual typing still has to give `rest` SOME type, and does so by
 * matching the excess of the target signature positionally into a TUPLE --
 * here `[(E['Bindings'] | {})?, ExecutionContext?]` -- which reads exactly
 * like a real, closed, two-element shape and is not one: it is the target
 * signature's tail, re-packaged, and the only reason it has a fixed arity at
 * all is that the target signature does. A caller of `fetch` is free to pass
 * zero, one, or two of those trailing arguments -- the language's own rest
 * binding, unaffected by how the contextual type happened to spell it.
 *
 * `structural.ts`'s `typeAt` already reaches exactly this conclusion for a
 * REFERENCE to such a parameter inside the function's own body (`rest[0]`,
 * `rest[1]`, a spread) -- see `restParameterArrayElementAt`, which shares
 * this function's core test. `structural-parts.ts`'s `parameterOf` (the
 * callable's own published ABI) is a second authority describing the
 * identical parameter, and calls THIS function (`restParameterArrayTypeOf`)
 * directly -- it already has the declaration in hand, having resolved it
 * itself, so it never needed `restParameterArrayElementAt`'s own node-shape
 * dispatch.
 *
 * A THIRD authority describes the same parameter again, through
 * `restParameterArrayElementAt`, and used to disagree with the other two:
 * `contributeParameter` (`producers/bindings.ts`) builds the binding that
 * INITIALIZES `rest` -- the frame slot both the signature and every
 * body-side read ultimately answer through -- by asking `structural.ts`'s
 * `typeAt` for the PARAMETER DECLARATION node itself, not a reference to it.
 * `restParameterArrayElementAt` used to require an identifier
 * (`ts.isIdentifier(node)`), so that call never reached this collapse at
 * all and published the checker's raw closed tuple straight into the
 * binding -- correct for the SIGNATURE (`parameterOf`) and for every
 * REFERENCE inside the body, wrong for the one binding both of those
 * actually read through. `restParameterArrayElementAt` now accepts the
 * declaration node directly (see `restParameterDeclarationAt`, below), so
 * all three authorities derive the identical collapse from the identical
 * source and cannot disagree.
 *
 * Gated exactly as its body-side counterpart is, for the same reasons:
 *  - UNANNOTATED only (`declaration.type === undefined`) -- an explicit
 *    `...args: [string, number]` is the program stating a real, closed
 *    shape, and this must never override that;
 *  - the checker's answer must be a tuple with at least one NON-required
 *    element. A checker-inferred CLOSED tuple (every position required) is
 *    left exactly alone -- that is a real, settled arity, not an artifact of
 *    contextual matching against a shorter signature.
 *
 * `null` means "the checker's own answer stands", the same safe default
 * every function in this file shares.
 */
/**
 * The per-position types of a rest parameter whose DECLARED type is a closed
 * tuple -- every position required, no optional, rest or variadic element --
 * or `null` for anything else.
 *
 * `/** @param {[number, number, number, number, number]} args *\/ function
 * texStorage2D( ...args ) { gl.texStorage2D( ...args ) }`: three's
 * `WebGLState.js` as the native-webgl-angle plugin rewrites its `...arguments`
 * forwarders. The parameter's cell is an array (the rest slot materializes
 * one), but its declaration states its LENGTH and the type at each position,
 * and the checker refuses any call that passes a different count. Two
 * consumers read this one fact: `producers/tuple-spread.ts` expands a spread
 * of such a parameter into that many constant-index reads, and
 * `parameter-bindings.ts` hands the callee's formals the position types --
 * which must agree, or the operands say `number` while the formal's storage
 * says "unresolved".
 */
export const declaredClosedTupleRestElementsOf = (
  checker: ts.TypeChecker,
  declaration: ts.ParameterDeclaration
): readonly ts.Type[] | null => {
  if (declaration.dotDotDotToken === undefined) return null
  const declared = checker.getTypeAtLocation(declaration)
  if (!checker.isTupleType(declared)) return null
  const reference = declared as ts.TupleTypeReference
  const elements = checker.getTypeArguments(reference)
  if (elements.length === 0) return null
  const allRequired = elements.every(
    (_, index) => (reference.target.elementFlags[index] ?? ts.ElementFlags.Required) === ts.ElementFlags.Required
  )
  return allRequired ? elements : null
}

export const restParameterArrayTypeOf = (checker: ts.TypeChecker, declaration: ts.ParameterDeclaration): ts.Type | null => {
  if (declaration.dotDotDotToken === undefined || declaration.type !== undefined) return null
  // STATED, not HOLDS: this asks what the checker's own CONTEXTUAL TYPING
  // produced for this unannotated rest parameter -- a `ts.TupleTypeReference`
  // whose internal shape (`.target`, `.elementFlags`) this function unwraps
  // by hand -- not what value the parameter carries at runtime. A census
  // answer is a real `ts.Type` too, but for a DIFFERENT node (a call-site
  // argument, a write), with no reason to be the tuple-from-target-signature
  // artifact this specifically detects and widens; substituting it here would
  // desync this function from the two other authorities the module comment
  // names (`structural.ts`'s `restParameterArrayElementAt`,
  // `structural-parts.ts`'s `parameterOf`) that all derive this collapse from
  // this SAME checker-native tuple. Left as a direct checker call.
  const own = checker.getTypeAtLocation(declaration)
  if (!checker.isTupleType(own)) return null
  const reference = own as ts.TupleTypeReference
  const target = reference.target
  const elements = checker.getTypeArguments(reference)
  if (elements.length === 0) return null
  const allRequired = elements.every((_, index) => (target.elementFlags[index] ?? ts.ElementFlags.Required) === ts.ElementFlags.Required)
  if (allRequired) return null
  return restTupleElementTypeOf(checker, elements)
}

/**
 * The ONE type an open-arity rest array's every position can hold.
 *
 * `widestOf` answers first and usually answers: when every position genuinely
 * joins under one of them, that type keeps the forwarding array a well-typed
 * native array instead of a tagged union nobody wrote.
 *
 * Its REFUSAL is the part that needed an answer here. Before its own vacuous-
 * coverage veto existed (`derived-expression-type.ts`), hono's
 * `HonoBase.fetch` -- declared `(request, Env?: E['Bindings'] | {},
 * executionCtx?: ExecutionContext) => ...` and implemented `(request,
 * ...rest) => ...` -- joined the contextual tuple
 * `[(E['Bindings'] | {})?, ExecutionContext?]` down to position 0 alone,
 * because every object type is assignable to `{}`. The array published
 * `array-object(optional(dynamic | record{}))`, naming no `ExecutionContext`
 * at all, and `request(path, init, Env, executionCtx)` forwarding a real one
 * had no conversion into it. `widestOf` now refuses that join instead of
 * lying about it, and a refusal used to leave the checker's raw CLOSED tuple
 * standing as the rest parameter's type -- the very shape this file's header
 * explains is not what `rest` holds.
 *
 * So a refusal states the union of every position, which is exactly the
 * policy `restParameterUnionOfTuplesElementTypeOf` already states for the
 * other of TypeScript's two notations for variable arity ("the union of every
 * arm's every element states exactly what the array holds and nothing more").
 * The two notations now agree on this case as well.
 *
 * `undefined` is deliberately NOT stripped from that union, unlike in the
 * sibling. There the positions come from different ARMS and the read past a
 * shorter arm's end is what supplies absence; here they are the checker's own
 * OPTIONAL elements of one tuple, whose `undefined` is a value the caller may
 * actually pass (`request(path, init, undefined, ctx)` is how hono's own
 * `request` forwards a missing `Env`), so dropping it would publish an
 * element narrower than the calls the signature admits.
 */
const restTupleElementTypeOf = (checker: ts.TypeChecker, elements: readonly ts.Type[]): ts.Type | null => {
  const widest = widestOf(checker, elements)
  if (widest !== null) return widest
  const kept = [...new Set(elements.filter((element) => (element.flags & ts.TypeFlags.Never) === 0))]
  if (kept.length === 0) return null
  return kept.length === 1 ? kept[0]! : unionTypeOf(checker, kept)
}

/**
 * The widened element type of an EXPLICITLY ANNOTATED rest parameter whose
 * declared type is a union of tuples -- `...args: [] | [TNext]`, exactly how
 * `lib.es2015.generator.d.ts` spells `Generator.prototype.next`'s "zero or one
 * argument" parameter.
 *
 * This says the same thing `[TNext?]` -- one tuple with an optional trailing
 * element -- would say, in the other of TypeScript's two notations for
 * variable arity: a single tuple whose optional positions
 * `restParameterArrayTypeOf` above already widens by reading `elementFlags`
 * off ONE `TupleTypeReference`. A union of several distinctly-lengthed tuples
 * is the same fact spread across several types instead of several positions
 * of one, so this collects every element type out of every arm and widens
 * across all of them the identical way -- `widestOf` does not care which
 * tuple or which position an element came from, only whether every element it
 * is handed agrees on one wider type.
 *
 * Left ungated by `declaration.type`, unlike its sibling: there is no bare
 * checker-inferred form of this shape to guard against overriding -- a
 * program can only reach a union of tuples here by writing the annotation out
 * (`restParameterArrayTypeOf` already owns the unannotated, single-tuple
 * case), so an explicit `[] | [TNext]` is exactly the input this exists to
 * widen, not a real, closed shape it would be wrong to touch.
 *
 * Without this, `structural-parts.ts`'s `parameterOf` finds `declared` is
 * neither `isArrayType` nor `isTupleType` (a union of tuples is itself
 * neither), falls into `restNotArrayShaped`'s bare-`any` fallback, and wraps
 * the WHOLE UNION as if it were one element: `Array<[] | [TNext]>` instead of
 * `Array<TNext>`. Every call site then argument-packs a raw `TNext` value
 * against a parameter slot declaring a one-tuple record, which is `next(v)`'s
 * "passes a scalar argument into a parameter slot carrying record(...)"
 * emission refusal for any generator whose `TNext` resolved to a native
 * carrier.
 *
 * `widestOf` REFUSING is not a reason to hand the union back untouched. The
 * arms of a real overload-shaped rest -- hono's `defineWebSocketHelper`,
 * `...args: [createEvents, options?] | [c, events, options?]` -- state
 * unrelated types at the same ordinal, so no one element covers the rest, and
 * before this the whole union fell through to `parameterOf`'s
 * `restNotArrayShaped` fallback and became `Array<[A, B?] | [C, D, E?]>`:
 * every element of the array claimed to be a whole argument LIST. That is not
 * a widening that failed, it is a wrong statement about the value -- the array
 * holds one argument per slot, never a tuple -- and it is what the binding
 * (`structural.ts`'s `rest-parameter-array-element`) could never agree with,
 * since the binding kept the union itself and derived a tagged union of
 * positional records. The union of every arm's every element states exactly
 * what the array holds and nothing more, and both authorities derive it from
 * this one function, so they cannot disagree about it.
 *
 * An optional position's `undefined` is dropped from that union, for the reason
 * `impliedPatternElementOfArms` below already states about the same kind of
 * evidence: a position's `undefined` is POSITIONAL -- an arm that is shorter,
 * or a trailing `options?` nobody passed -- and the READ past the end of the
 * array is what supplies it, per position. Keeping it would wrap the whole
 * element in `optional(...)`, which says every slot of the array may be absent
 * even where an arm requires one.
 */
export const restParameterUnionOfTuplesElementTypeOf = (checker: ts.TypeChecker, declared: ts.Type): ts.Type | null => {
  if (!declared.isUnion()) return null
  if (!declared.types.every((member) => checker.isTupleType(member))) return null
  const elements = declared.types.flatMap((member) => checker.getTypeArguments(member as ts.TupleTypeReference))
  if (elements.length === 0) return null
  const widest = widestOf(checker, elements)
  if (widest) return widest
  // `never` only: a position nothing states contributes nothing, while an `any`
  // one genuinely widens the element and must stay -- dropping it would publish
  // an array narrower than the program's own annotation.
  const stated = elements
    .map((element) => withoutUndefinedMember(checker, element))
    .filter((element) => (element.flags & ts.TypeFlags.Never) === 0)
  return stated.length === 0 ? null : unionTypeOf(checker, [...new Set(stated)])
}

/**
 * The type the physical parameter SLOT holds.
 *
 * An omitted argument is `undefined`, and a defaulted parameter's initializer
 * runs inside the callee over exactly this slot, so an optional or defaulted
 * slot has to hold `undefined` alongside whatever the body ends up binding.
 *
 * The widening is done as a TYPE, by the checker, rather than as an absence
 * flag layered over an already-derived carrier. Those two are not the same
 * answer: a flag can only say "absent or not", so a parameter whose declared
 * type already spends absence on `null` -- `f(x: T | null = null)`, and the
 * JSDoc spelling `@param {?T} [x=null]` that three.js writes throughout -- had
 * no state left to say WHICH absent value it holds, and was refused outright.
 * As a type it is just a three-armed union, which `representation/union.ts`
 * has always carried as a tagged union with a `null` arm, an `undefined` arm
 * and a `present` arm.
 *
 * `getNullableType` is the same public API TypeScript's own `addOptionality`
 * uses, and it flattens: the result is one flat union, never a union nested
 * inside a union, which matters because the two are different interned shapes
 * and only the flat one derives to the three-armed carrier.
 *
 * A rest parameter is left alone -- its declared type is already the array the
 * language binds, and there is no omission to encode.
 */
export const parameterSlotTypeOf = (
  internUnion: (members: readonly StructuralTypeId[]) => StructuralTypeId,
  undefinedType: StructuralTypeId,
  flags: ParameterSlotFlags,
  type: StructuralTypeId
): StructuralTypeId => (flags.rest || (!flags.optional && !flags.hasInitializer) ? type : internUnion([type, undefinedType]))

/**
 * AN UNANNOTATED REST PARAMETER IS ALWAYS AN ARRAY AT RUNTIME, WHATEVER
 * ARITY-TRACKING TUPLE THE CHECKER GAVE IT FOR CHECKING PURPOSES.
 *
 * `FunctionDeclarationInstantiation` (ECMA-262 10.2.11 step 28) binds a rest
 * parameter to a fresh `Array`, unconditionally -- that is what the value
 * physically is, regardless of how the checker typed the binding. When an
 * unannotated `...args` is contextually typed against a target with more
 * than one possible tail shape -- an overloaded call type
 * (`hono/src/context.ts`'s `NewResponse` has two signatures, `(data,
 * status?, headers?)` and `(data, init?)`), or a single signature with its
 * own optional trailing parameters -- the checker states that as a TUPLE
 * with optional/rest/variadic elements, one arity per possible call shape
 * joined into one type. That tuple is real and correct for checking a call
 * `args` is forwarded into, but it does not describe `args` itself: the
 * program never wrote a fixed-arity value there, and no two calls into this
 * function are required to pass the same number of arguments.
 *
 * `tuple-spread.ts`'s `closedTupleElementTypesOf` already refuses to expand
 * exactly this shape positionally (an optional/rest/variadic element means
 * the arity is not settled), which is correct -- but leaving the binding
 * typed as a tuple after that refusal is what actually breaks: representing
 * an open-arity tuple needs a dictionary-shaped carrier with no
 * `[Symbol.iterator]`, so every consumer that needs to iterate or
 * range-copy `args` (a spread into another call, `for`-`of`) is refused for
 * a reason that names a carrier this value was never supposed to have.
 * Collapsing it to the array it actually is restores the native iteration
 * cursor `hasNativeIterationCursor` already grants any other `T[]`.
 *
 * Gated tightly, to touch only the binding itself:
 *  - the parameter must be UNANNOTATED (`declaration.type === undefined`).
 *    An explicit `...args: [string, number]` is the program stating a real,
 *    closed shape, and this must not override that;
 *  - the checker's type must be a tuple whose elements are NOT all
 *    `Required` -- a checker-inferred CLOSED tuple (every position
 *    required, one arity) is left alone: `tuple-spread.ts` already expands
 *    that positionally, and collapsing it here would throw away real
 *    per-position typing a sound expansion could still use.
 *
 * The array's element type is `widestOf` the tuple's own elements -- the
 * same join two `return` statements or two branches of a conditional must
 * already agree through (`derived-expression-type.ts`). When every element
 * genuinely joins under one type, using it keeps a well-typed forwarding
 * array native instead of boxing it. When no single element type covers
 * every position (`widestOf` refuses), this refuses too, rather than
 * inventing a join the checker never stated -- the existing tuple/record
 * path is the fallback, unchanged.
 */
export const restParameterArrayElementAt = (checker: ts.TypeChecker, identities: IdentityTable, node: ts.Node): ts.Type | null => {
  const declaration = restParameterDeclarationAt(checker, identities, node)
  if (!declaration) return null
  // The core test -- unannotated, checker-tupled, not every element
  // required -- is shared with the signature side of this same question;
  // see `parameter-slot.ts`'s `restParameterArrayTypeOf` for why there is
  // only one function answering it.
  return restParameterArrayTypeOf(checker, declaration)
}

/**
 * The body-side entry to `restParameterUnionOfTuplesElementTypeOf` above --
 * the same collapse `structural-parts.ts`'s `parameterOf` applies to the ABI
 * slot, reached from either shape a node names (`restParameterDeclarationAt`).
 *
 * That collapse was wired into `parameterOf` alone when `Generator.next`'s
 * `[] | [TNext]` needed it, re-opening exactly the disagreement this file's
 * header describes: the ABI published `array-object(...)` for a rest
 * parameter annotated as a union of tuples while the binding kept the
 * checker's raw union, which `derive.ts` lays out as a tagged-union of
 * positional records once any arm has a non-uniform or optional position.
 * `projection/abi.ts` then refused the function -- hono's
 * `defineWebSocketHelper` (`...args: [createEvents, options?] | [c, events,
 * options?]`) with 'parameter 0 is bound as "tagged-union(...)" but the ABI
 * declares "array-object(...)"'. `[] | [T]` never showed it only because both
 * arms happen to derive to the array carrier anyway. The ABI is the right
 * authority: FunctionDeclarationInstantiation binds a rest parameter to one
 * fresh Array whatever static shapes describe it, and `packRestArguments`
 * has no convention for a discriminated rest slot.
 */
export const restParameterUnionOfTuplesElementAt = (checker: ts.TypeChecker, identities: IdentityTable, node: ts.Node): ts.Type | null => {
  const declaration = restParameterDeclarationAt(checker, identities, node)
  // A REST parameter only, as `parameterOf` gates its own call on `flags.rest`:
  // a destructured ordinary parameter can also be typed as a union of tuples
  // (hono's `([[, route]]) => route` over `[[H, Route], ParamIndexMap] |
  // [[H, Route], Params]` elements) and holds ONE tuple value, not an array
  // of arms -- collapsing it here made the binding an array while the ABI
  // kept the union, the same disagreement in the other direction.
  if (!declaration || declaration.dotDotDotToken === undefined) return null
  return restParameterUnionOfTuplesElementTypeOf(checker, checker.getTypeAtLocation(declaration))
}

/**
 * `restParameterArrayElementAt`'s sibling for CALL-SITE evidence rather
 * than the checker's own contextual-tuple widening: `parameter-bindings.ts`'s
 * `restElementTypeAt` joins the actual arguments every reachable call passes
 * at or past the rest parameter's own ordinal, which is real evidence about
 * what the array holds and outranks a bare checker guess -- the same
 * priority `structural-parts.ts`'s `parameterOf` already gives an ordinary
 * parameter's census answer over `restArray`. Resolves the same DECLARATION
 * `restParameterArrayElementAt` does, from either shape a node names, so a
 * body-side reference (`structural.ts`'s `typeAt`) and the ABI's own slot
 * (`parameterOf`) read the identical fact and cannot disagree about it.
 */
export const censusRestElementAt = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  parameters: Pick<ParameterBindingCensus, 'restElementTypeAt'>,
  node: ts.Node
): ts.Type | null => {
  const declaration = restParameterDeclarationAt(checker, identities, node)
  return declaration ? (parameters.restElementTypeAt?.(declaration) ?? null) : null
}

/**
 * The rest parameter `node` names, whichever of the two shapes names one:
 * the DECLARATION itself -- `contributeParameter`'s own binding-initialize
 * site (`producers/bindings.ts`), which types the frame slot before any
 * reference to it exists -- or an IDENTIFIER that reads it (`rest[0]`,
 * `rest.length`, a spread, anywhere inside the function's own body). Both
 * name the same physical rest parameter and must resolve to the same
 * declaration for `restParameterArrayTypeOf` to answer both identically;
 * see this file's header comment for the third authority
 * (`structural-parts.ts`'s `parameterOf`), which resolves its own
 * declaration and calls `restParameterArrayTypeOf` directly, bypassing this
 * dispatch entirely -- unaffected by this change and already agreeing with
 * it.
 */
const restParameterDeclarationAt = (checker: ts.TypeChecker, identities: IdentityTable, node: ts.Node): ts.ParameterDeclaration | null => {
  if (ts.isParameter(node)) return node
  if (!ts.isIdentifier(node)) return null
  const symbol = checker.getSymbolAtLocation(node)
  const declaration = symbol ? identities.declarationOfSymbol(symbol) : null
  return declaration && ts.isParameter(declaration) ? declaration : null
}

/**
 * The element an implied array pattern's value is STORED as, read out of the
 * tuple arms its call sites (and its own default) pass: every stated position
 * of every arm, plus -- for a position no arm reaches -- the pattern element's
 * own default, which is then the only value that position ever binds. One
 * covering type when the positions agree (`widestOf`); their union when they
 * do not, because `[null, 0, false, '']` is a real array of four kinds and
 * the pattern reads each position back out of it. A position's `undefined`
 * is positional (an optional tuple element, a shorter arm) and the read
 * supplies it per position (`patternReadTypeAt`), so it is not an element.
 * `any` when nothing states a position at all.
 */
/** The non-null arms a set of holders offers -- a union holder contributes each member by itself. */
const holderArmsOf = (checker: ts.TypeChecker, holders: readonly ts.Type[]): ts.Type[] =>
  holders.flatMap((holder) => {
    const nonNull = checker.getNonNullableType(holder)
    return nonNull.isUnion() ? nonNull.types.map((arm) => checker.getNonNullableType(arm)) : [nonNull]
  })

/**
 * Whether every holder PROVES a value at `position`: each arm is a tuple whose
 * required prefix reaches past it. The pattern reads out of the array the
 * parameter stores, so a position is `element | undefined` in general -- but
 * `[x, y = 2] = [1]` reached only as `m()` never leaves `x` absent, and
 * spelling it optional there hands `x + y` an optional operand for nothing.
 * A plain-array arm proves no position; an optional tuple element proves none
 * either.
 */
export const impliedPatternPositionPresentEverywhere = (
  checker: ts.TypeChecker,
  holders: readonly ts.Type[],
  position: number
): boolean => {
  const arms = holderArmsOf(checker, holders)
  const holdsUndefined = (type: ts.Type): boolean =>
    (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
    (type.isUnion() && type.types.some(holdsUndefined))
  return (
    arms.length > 0 &&
    arms.every((arm) => {
      if (!checker.isTupleType(arm) || (arm as ts.TupleTypeReference).target.minLength <= position) return false
      // A required tuple position typed `undefined` is a HOLE (`[,]` types
      // as `[undefined]`), and a hole reads as absent: not a proof.
      const at = checker.getTypeArguments(arm as ts.TupleTypeReference)[position]
      return at !== undefined && !holdsUndefined(at)
    })
  )
}

export const impliedPatternElementOfArms = (
  checker: ts.TypeChecker,
  holders: readonly ts.Type[],
  pattern: ts.ArrayBindingPattern
): ts.Type | null => {
  const arms = holderArmsOf(checker, holders)
  if (arms.length === 0 || !arms.every((arm) => checker.isTupleType(arm) || checker.isArrayType(arm))) return null
  const usable = (type: ts.Type): boolean => !isUnusableEvidence(type) && (type.flags & ts.TypeFlags.Undefined) === 0
  const settle = (type: ts.Type): ts.Type => withoutUndefinedMember(checker, checker.getBaseTypeOfLiteralType(type))
  // A plain-array arm (`f(values)` for `var values = [1, 2, 3]`) states its
  // element at EVERY position, a tuple arm states each position by itself.
  const everywhere = arms.flatMap((arm) => {
    if (checker.isTupleType(arm)) return []
    const element = checker.getIndexTypeOfType(arm, ts.IndexKind.Number)
    return element ? [settle(element)] : []
  })
  const byPosition = arms.map((arm) => (checker.isTupleType(arm) ? checker.getTypeArguments(arm as ts.TupleTypeReference).map(settle) : []))
  const width = Math.max(pattern.elements.length, ...byPosition.map((positions) => positions.length))
  const stated: ts.Type[] = []
  let sawDynamic = false
  for (let position = 0; position < width; position++) {
    const offered = [
      ...everywhere,
      ...byPosition.flatMap((positions) => (positions[position] === undefined ? [] : [positions[position] as ts.Type]))
    ]
    if (offered.some((type) => (type.flags & ts.TypeFlags.Any) !== 0)) sawDynamic = true
    const at = offered.filter(usable)
    if (at.length > 0) {
      stated.push(...at)
      continue
    }
    const element = pattern.elements[position]
    if (element && ts.isBindingElement(element) && element.initializer && !element.dotDotDotToken) {
      const fallback = settle(checker.getTypeAtLocation(element.initializer))
      if (usable(fallback)) stated.push(fallback)
    }
  }
  // Arms that state NO position (`f([])` against `[{ x }]`) hold nothing: the
  // element is `never`, the read past every arm is `undefined`, and a nested
  // pattern over it throws where the language throws. Only an `any` somewhere
  // in the evidence makes the element genuinely unknown.
  if (stated.length === 0) return sawDynamic ? checker.getAnyType() : checker.getNeverType()
  return widestOf(checker, stated) ?? unionTypeOf(checker, [...new Set(stated)]) ?? checker.getAnyType()
}

/** The internal union constructor; the public checker exposes none (the same reach `field-bindings.ts` takes). */
const unionTypeOf = (checker: ts.TypeChecker, types: readonly ts.Type[]): ts.Type | null => {
  const constructing = checker as unknown as { getUnionType?: (types: readonly ts.Type[]) => ts.Type }
  return typeof constructing.getUnionType === 'function' ? constructing.getUnionType(types) : null
}

export const impliedPatternArrayElementAt = (
  checker: ts.TypeChecker,
  parameters: ParameterBindingCensus,
  node: ts.Node
): ts.Type | null => {
  const parameter = impliedPatternParameterOf(checker, node)
  if (!parameter || !ts.isArrayBindingPattern(parameter.name)) return null
  // The census publishes a disagreement it settled as SYNTHESIZED arms
  // (`unionArmsAt`), never as one `ts.Type` -- `f([1, 2])` next to `f([])`
  // is exactly that -- so the arms are asked for before the single answer.
  const synthesized = parameters.unionArmsAt(parameter)
  const holders = synthesized ?? [parameters.typeAt(parameter) ?? checker.getTypeAtLocation(parameter)]
  return impliedPatternElementOfArms(checker, holders, parameter.name)
}
