import ts from 'typescript'
import { definitelyReturns } from './return-paths.js'
import { carriesUnsubstitutedGeneric, emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { emptyCollectionBindingCensus, type CollectionBindingCensus } from './collection-bindings.js'
import { emptyObjectBagCensus, type ObjectBagCensus } from './object-bag-bindings.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'
import type { ValueFlowIndex } from './flow/model.js'
import { classFamilyMemberReadTypeOf } from './flow/class-family-member-read.js'
import { thisConstructorFamilyOf } from './flow/member-call-forwarding.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import {
  annotationStatesNothing,
  containsUnstatedPosition,
  narrowsOnlyUnstatedPositions,
  derivedExpressionType,
  disjointUnionMembersOf,
  indexedTypeOf,
  explicitThisCallReturnType,
  overloadInvariantReturnTypeAt,
  isStandardInterfaceType,
  isUnusableEvidence,
  joinOfWrites,
  jsDocTypeStatesNothing,
  literalMemberNameOf,
  memberTypeOf,
  objectAssignTargetType,
  unwrapExplicitThisCall,
  widestOf
} from './derived-expression-type.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'

/**
 * The type an unannotated JavaScript function actually RETURNS.
 *
 * The mirror of `parameter-bindings.ts`, one direction over. An unannotated
 * parameter is typed `any` because TypeScript infers a parameter's type from
 * its annotation alone; an unannotated function's return type is typed `any`
 * for a related but distinct reason -- the checker DOES infer an unannotated
 * return type from the function's own `return` statements, and usually
 * succeeds, but for a function complicated enough (mutually recursive with
 * its own return, too large a body, a shape the inferencer's heuristics give
 * up on) it bails to `any` rather than reporting nothing. `properties.get(
 * object)` in three.js's `WebGLProperties.js` returns `materialProperties`,
 * an object literal the checker can type exactly -- the declared/inferred
 * return of the enclosing factory is simply `any`, and every call to it reads
 * as a dynamic value even though the object it hands back has a real shape.
 *
 * Every type this module produces comes out of the checker, read at a
 * `return` statement's own expression or at one of its members -- never
 * invented. What this module contributes is attributing that answer to the
 * DECLARATION so a later call site can ask for it, and to a CALL EXPRESSION
 * whose resolved signature names that declaration.
 *
 * ## Composing with the parameter census
 *
 * The two censuses answer questions in opposite directions over the same
 * program -- what a PARAMETER holds, and what a RETURN produces -- and each
 * can be the other's evidence: `provider(gl).getExtension(name)` inside a
 * function whose own `gl` parameter this compiler bound from its callers
 * needs that binding to type the receiver before this module can resolve
 * what the call returns.
 *
 * The reverse direction -- a return type this module discovers feeding back
 * into a parameter binding upstream -- is NOT re-run here. This module is a
 * SINGLE ORDERED PASS: it is built from an already-settled
 * `ParameterBindingCensus` (the caller runs `censusParameterBindings` to a
 * fixpoint first, exactly as `structural.ts` already does) and never asks
 * that census to reconsider anything. A true fixpoint over both censuses
 * together was considered and rejected for this module: `parameter-bindings.
 * ts` already runs its OWN fixpoint to convergence before this module ever
 * sees it, and re-opening that fixpoint here would mean either mutating a
 * module this compiler does not own or re-implementing its 12-round
 * convergence loop wholesale duplicating ~700 lines this file would then have
 * to keep in lockstep. What this single pass therefore cannot see: a
 * parameter whose ONLY call-site evidence is the result of a function this
 * module resolves stays exactly as unbound as it is today, because
 * `censusParameterBindings` already finished before this module ran and does
 * not get a second look. `parameter-bindings.ts`'s own `resolvedReturnTypeOf`
 * covers the common case of that direction already -- it is a looser,
 * un-refusal-counted version of this module's algorithm, reached from inside
 * that fixpoint's own argument resolution -- so the gap this single pass
 * leaves is narrower than it first appears: only the return shapes THIS
 * module resolves and that looser one does not (a stricter cast rule, a
 * disagreement this module refuses that the other one guessed past, explicit
 * recursion detection) are invisible to a parameter bound upstream of it.
 *
 * ## What it refuses
 *
 * Every refusal below leaves the function's return exactly as the checker
 * already reports it -- `any`, boxed -- because a wrong type is far worse
 * than a boxed one:
 *
 * - a generator (`function*`): its `return` value is not what a caller
 *   observes at all, `Generator<T, TReturn, TNext>` is, and this module makes
 *   no claim about that protocol.
 * - an `async` function: what a caller of an async function observes is
 *   whatever `await`ing its `Promise` produces, one more layer removed from
 *   any `return` statement's own type than this module reaches for.
 * - a function with no `return` statement at all, or a bare `return;` among
 *   its returns: the first always evaluates to `undefined` and the second
 *   sometimes does, and `void`/`undefined` are exactly the unusable evidence
 *   `isUnusableEvidence` already refuses everywhere else in this compiler.
 * - a function whose closing brace is reachable on some path that never hits
 *   a `return` -- `T | undefined`, unless the checker itself already reports
 *   that at some return's own expression, which it will not, so this is
 *   refused rather than guessed at from source shape.
 * - a `return` whose own expression is an `as`/`<T>` cast: the program is
 *   making a statement, honoured exactly as `parameter-bindings.ts` honours a
 *   parameter declared `: any` -- taken at the checker's own face value for
 *   that expression, and not read PAST, because a cast is precisely where the
 *   checker's answer stops being derived from anything else.
 * - a `return` that (directly, or through a chain this module can resolve)
 *   calls the function's own declaration, or a declaration already being
 *   resolved on the same call stack: two functions calling each other's
 *   return value to determine their own is exactly the circularity the
 *   checker itself bails to `any` over, and this module bails the same way
 *   rather than looping.
 * - two or more `return`s whose types disagree, tested by the shared
 *   `widestOf` (`derived-expression-type.ts`) -- the identical join
 *   `parameter-bindings.ts` uses for two call sites: agreement is never
 *   spelling, and a union of this compiler's own making is a guess nobody
 *   wrote.
 */
export interface ReturnBindingCensus {
  /**
   * The type this node's evaluation actually produces, once an unannotated
   * function's inferred `any` return is replaced by what its `return`
   * statements produce -- or `null` when nothing here improves on the
   * checker's own answer.
   *
   * Answers exactly two shapes of node: the function-like declaration itself
   * (the same declaration a `resolvedSignature.declaration` points at), and a
   * call or `new` expression whose resolved signature names one of those
   * declarations. Anything else -- a bare identifier, a property access --
   * is `null` here; a consumer that needs a settled type at one of those
   * reaches it through the call or declaration this module already answers,
   * the same way `parameter-bindings.ts`'s own internal resolver does.
   */
  readonly typeAt: (node: ts.Node) => ts.Type | null
  /** The member list for a SYNTHESIZED disjoint-union carrier at this node -- see `ParameterBindingCensus.unionArmsAt`, the same rule asked of a function's `return`s instead of a parameter's argument set. */
  readonly unionArmsAt: (node: ts.Node) => readonly ts.Type[] | null
  /**
   * The narrowed return type of a declaration whose ANNOTATION this census
   * read as an upper bound -- the return form of
   * `ParameterBindingCensus.statedTypeAt`, needed for the identical reason its
   * own doc gives: the checker's answer there is a perfectly good structure,
   * so the guarded census fallback never fires.
   */
  readonly statedTypeAt: (node: ts.Node) => ts.Type | null
  /** How many declarations this census bound a return type for, for measurement. */
  readonly boundCount: number
  /** Why each declaration this census could not bind was refused, one entry per declaration and each carrying its own owner -- see `census-refusal.ts`. */
  readonly refusals: readonly CensusRefusal[]
  /** Why this particular declaration was not bound, for attributing one declaration rather than a total. */
  readonly refusalOf: (declaration: ts.SignatureDeclaration) => string | null
}

/** A census that binds nothing, for callers that state no program. */
export const emptyReturnBindingCensus: ReturnBindingCensus = {
  typeAt: () => null,
  statedTypeAt: () => null,
  unionArmsAt: () => null,
  boundCount: 0,
  refusals: [],
  refusalOf: () => null
}

/** A function-like declaration this module can attribute a return type to. */
type ReturnCandidateDeclaration =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration

/**
 * The return type a contextually typed, unannotated function EXPRESSION is
 * used at, when it differs from the one the checker infers for its body --
 * or `null` when nothing here improves on the checker's answer.
 *
 * `extra: (value) => value === 'ok' ? undefined : [Diagnostics.X, value]`
 * under a slot typed `(value: string) => [DiagnosticMessage, ...Arg[]] |
 * undefined`: the checker infers the arrow's OWN return as the body's,
 * `[DiagnosticMessage, string] | undefined`, a closed tuple, while every
 * caller reaches the function through the slot and its open-ended one. Two
 * conventions for one function -- the body's return converts into the
 * closed record, the slot's callers expect the array -- and the body's
 * conversion had no recipe. The slot's signature IS the function's
 * convention: it is the only type through which the value is ever called,
 * and the checker itself only admits the arrow there by assignability, so
 * publishing it is publishing the fact the program already stated.
 *
 * Held to the cases where the slot's answer is a complete one: a single
 * non-generic contextual signature, a return that is a concrete type (not
 * `void`, which the language lets any body satisfy, not `any`/`unknown`,
 * and nothing still carrying a type parameter, which is monomorphization's
 * to settle), parameters the arrow did not annotate itself (so its own
 * parameter types are already the slot's), and an inferred return the
 * checker agrees is assignable.
 */
const contextualReturnTypeOf = (checker: ts.TypeChecker, node: ts.ArrowFunction | ts.FunctionExpression): ts.Type | null => {
  if (node.asteriskToken || node.parameters.some((parameter) => parameter.type !== undefined)) return null
  const contextual = checker.getContextualType(node)
  if (!contextual) return null
  // An OPTIONAL slot's contextual type carries `undefined` beside the
  // signature (`extra?: (value) => ...`); the absence is the slot's, not the
  // function's, and it holds no signature to read.
  const signatures = checker.getNonNullableType(contextual).getCallSignatures()
  const signature = signatures.length === 1 ? signatures[0] : undefined
  if (!signature || (signature.getTypeParameters()?.length ?? 0) > 0) return null
  const returned = checker.getReturnTypeOfSignature(signature)
  const unsettled = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.Instantiable
  if ((returned.flags & unsettled) !== 0 || carriesUnsubstitutedGeneric(checker, returned)) return null
  // `T | PromiseLike<T>` -- what every promise reaction slot declares -- is
  // not a convention any function physically has. The promise protocol
  // FLATTENS a thenable result (`gea::Promise<V>::then` deduces its own
  // result through `promise_result_t`, exactly as ECMA-262 27.2.1.3.2 does),
  // so the value a handler hands back is either the payload or a promise of
  // it, never a sum of the two. Publishing the slot's union as the body's ABI
  // made `(v) => v * 2` return `TaggedUnion<double, Ref<{}>>` -- with the
  // `PromiseLike` arm sealed as an EMPTY struct, since its only member is a
  // method -- and clang rejected the assignment of that `then` result to the
  // `Promise<double>` the checker itself typed the call as. The arrow's own
  // inferred return is the honest answer in both directions: a handler
  // returning the payload carries the payload, and one returning a promise
  // carries the promise, which is what the flattening reads.
  if (flattenedUnionSlot(checker, returned)) return null
  // An ASYNC body settles exactly one promise, so its physical convention is
  // `Promise<T>` and never a sum of promises: `abi.result.kind === 'promise'`
  // is what the return slot (`projection/slots.ts`), the await path and the
  // settle path all read, and a `tagged-union` there leaves the body's own
  // `return v` with nothing to settle into.
  //
  // The slot that produces one is a union of callable types, whose signatures
  // the checker COMBINES into a single one with a union return -- so the
  // `signatures.length === 1` gate above does not see it. hono's handler slot
  // is exactly that: `H<R> = Handler<R> | MiddlewareHandler<R>` combines to a
  // return of `R | Promise<R | void>`, which for an async handler (`R` is then
  // inferred as `Promise<Response>`) reads `Promise<Response> | Promise<void |
  // Promise<Response>>`. `flattenedUnionSlot` above does not catch it because
  // BOTH arms are thenable, yet the two are the same admission list one
  // promise-wrap further out: awaiting either yields `Response | void`.
  // Published as the convention it made node-compat's hono-hello refuse four
  // `return c.text(...)` statements for want of a `Response -> tagged-union(
  // promise(Response) | promise(undefined | promise(Response)))` conversion.
  //
  // Held only against a return that is not a single promise, so the honest
  // widening still lands: a slot saying `() => Promise<number | string>` over
  // an `async () => 1` is one promise whose payload is wider than the body's,
  // which the body settles exactly as an annotation saying the same would.
  if (hasAsyncModifier(node) && (returned.isUnion() || (checker.getAwaitedType(returned) ?? returned) === returned)) return null
  const own = checker.getSignatureFromDeclaration(node)
  const inferred = own ? checker.getReturnTypeOfSignature(own) : null
  if (!inferred || inferred === returned || !checker.isTypeAssignableTo(inferred, returned)) return null
  return returned
}

/**
 * Whether a union slot is a PROTOCOL'S admission list rather than a
 * convention: one arm is a container the protocol unwraps, and another arm is
 * what it unwraps to.
 *
 * Two arms, one relation, and it is structural on both counts. A thenable arm
 * is any type with a callable `then`, which is exactly what ECMA-262
 * 27.2.1.3.2 resolves through. A sequence arm is any type with a number index
 * whose element is another arm, which is what `flatMap` flattens (ECMA-262
 * 23.1.3.11's FlattenIntoArray). Neither is a name check, and neither admits
 * a union whose arms are genuinely alternative results.
 */
const flattenedUnionSlot = (checker: ts.TypeChecker, returned: ts.Type): boolean => {
  if (!returned.isUnion()) return false
  const arms = returned.types
  const thenable = (arm: ts.Type): boolean => {
    const member = checker.getPropertyOfType(arm, 'then')
    const declaration = member ? (member.valueDeclaration ?? member.declarations?.[0]) : undefined
    if (!member || !declaration) return false
    return checker.getTypeOfSymbolAtLocation(member, declaration).getCallSignatures().length > 0
  }
  if (arms.some(thenable) && arms.some((arm) => !thenable(arm))) return true
  return arms.some((arm) => {
    const element = checker.getIndexTypeOfType(arm, ts.IndexKind.Number)
    return element !== undefined && arms.some((other) => other !== arm && checker.isTypeAssignableTo(other, element))
  })
}

const isReturnCandidateKind = (node: ts.Node): node is ReturnCandidateDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node)

/**
 * Every syntax kind that owns its OWN `return`s, so a walk collecting one
 * function's returns stops at the boundary of the next one -- and at a class
 * body, whose members are never this function's returns either, even though
 * `ts.forEachChild` would otherwise walk straight into them.
 */
const isScopeBoundary = (node: ts.Node): boolean =>
  isReturnCandidateKind(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isClassExpression(node) ||
  ts.isClassStaticBlockDeclaration(node)

/** Duplicated from `parameter-bindings.ts` (not exported there): `any` is the absence this module exists to fill. */
const isAnyType = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Any) !== 0

/**
 * A refusal's `owner`, rendered -- the declaration's own name where the
 * declaration syntax carries one (a function/method/getter's own name, or the
 * `const`/property it is assigned to for an anonymous function expression or
 * arrow), else `<anonymous>`, always with a file:line so two declarations that
 * happen to share a name (or share none) still name distinct sites. The same
 * node-text-plus-location shape `parameter-bindings.ts`'s own debug report
 * already prints (`debugReport`'s `<-  ${parameter.getText()...} @${file}:
 * ${line}` line) -- this module has no declaration-identity minting of its
 * own to reach for, and inventing one here would be a second copy of
 * `identity/ids.ts`'s `DeclarationId` scheme built to a different, unstable
 * shape.
 */
const ownerOf = (declaration: ReturnCandidateDeclaration): string => {
  const named = ts.getNameOfDeclaration(declaration)
  const parent = declaration.parent
  const label =
    (named && ts.isIdentifier(named) ? named.text : undefined) ??
    (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined) ??
    (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined) ??
    '<anonymous>'
  const file = declaration.getSourceFile()
  const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1
  return `${label} @${file.fileName.split('/').pop() ?? file.fileName}:${line}`
}

// `isUnusableEvidence` is now the ONE shared copy in
// `derived-expression-type.ts`, imported above. It used to be duplicated here
// on the reasoning that `parameter-bindings.ts`'s version additionally
// excludes bare `Function`; that module now composes with the shared base
// instead of restating it, so the base rules -- `any`, `void`, `never`, and a
// type that states nothing -- cannot drift between the two censuses that read
// each other's answers.

// `widestOf` lives in `derived-expression-type.ts` -- the ONE shared copy.
// `parameter-bindings.ts` imports it too now rather than keeping its own.

const hasAsyncModifier = (declaration: ReturnCandidateDeclaration): boolean =>
  (ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
  ) ?? false

/**
 * Whether the program stated a return type this compiler can READ -- an
 * annotation, or a JSDoc `@returns`/`@type` tag that resolves to something.
 *
 * The tag's mere presence is not the question. `checker.getTypeFromTypeNode`
 * degrades to `any` when a JSDoc node names a type the checker cannot bind at
 * that site, and three.js does this throughout -- `@returns {Texture}` in a
 * file that never imports `Texture`. Treating that as a stated type refuses
 * this census for a fact that is not there, and the declaration then carries
 * `dynamic(declared-any-never-narrowed)`: the program is recorded as having
 * declared the value dynamic when it did the opposite. `parameter-bindings.ts`
 * has drawn exactly this distinction since the call-site census landed; the
 * asymmetry was an oversight, not a rule.
 *
 * Measured on the three.js app: 1035 unannotated functions carry a JSDoc return tag,
 * and 48 of them resolve to `any`/`unknown` -- `{Texture}`, `{TypedArray}`,
 * `{AnimationClip}`, `{BufferAttribute}`, `{Group}`, `{Object3D}` and friends,
 * every one an unimported cross-module name. The other 987 resolve to a real
 * type and keep stopping this census exactly as before.
 */
const hasStatedReturnType = (checker: ts.TypeChecker, declaration: ReturnCandidateDeclaration): boolean => {
  // A real annotation that resolves to a NON-STATEMENT is the same absence
  // this function already refuses to read into an unresolvable JSDoc tag.
  // `getExtension( name: string ): object | null` states which values are
  // excluded (`number`, `string`, `null` is separate) and nothing whatever
  // about what the caller receives -- so every caller's variable inherits a
  // shape with no members, from an annotation that never claimed one. See
  // `annotationStatesNothing` for what stays a statement: `unknown`, a named
  // empty type, an explicit `: any`.
  if (declaration.type) return !annotationStatesNothing(checker, declaration.type, checker.getTypeFromTypeNode(declaration.type))
  const jsDocType = ts.getJSDocReturnType(declaration) ?? ts.getJSDocType(declaration)
  if (!jsDocType) return false
  return !jsDocTypeStatesNothing(checker, jsDocType)
}

/**
 * A return type the program DID state, whose statement is still only an UPPER
 * BOUND -- the RETURN form of `parameter-bindings.ts`'s `statedUpperBound`
 * and `field-bindings.ts`'s `statedUpperBoundOfField`, asked of the third
 * kind of cell the same value passes through.
 *
 * hono's `HonoRequest` is the measured case, and all three forms of the rule
 * are ONE value: the constructor parameter `matchResult: Result<[unknown,
 * RouterRoute]>` is narrowed to the concrete `Result<[H, RouterRoute]>` its
 * only caller passes, the field it is stored in narrows with it, and then
 * `get [GET_MATCH_RESULT](): Result<[unknown, RouterRoute]> { return
 * this.#matchResult }` hands it back out through an annotation that states
 * the same upper bound a third time. Reading that annotation as the last word
 * asks the backend to convert one `Result` carrier into the other at the
 * return -- which rebuilds two arrays, and an array rebuild is a COPY of an
 * array the caller still holds, so no backend can render it. The three cells
 * have to AGREE, which means the same rule holds at each of them.
 *
 * Only a real `.type` annotation is admitted, never a JSDoc tag: the tag
 * forms this file's `hasStatedReturnType` documents degrade to `any` when
 * they name an unimportable type, and `containsUnstatedPosition` cannot tell
 * that absence from a stated `any`.
 */
const statedReturnBound = (checker: ts.TypeChecker, declaration: ReturnCandidateDeclaration): ts.Type | null => {
  if (!declaration.type || declaration.body === undefined) return null
  if (declaration.getSourceFile().isDeclarationFile) return null
  const declared = checker.getTypeFromTypeNode(declaration.type)
  if (annotationStatesNothing(checker, declaration.type, declared)) return null
  if (isUnusableEvidence(declared)) return null
  return containsUnstatedPosition(checker, declaration.type, declared) ? declared : null
}

const unwrapParens = (node: ts.Expression): ts.Expression => {
  let current: ts.Expression = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

/** The runtime expression beneath an explicit `value as unknown as T` assertion. */
const sourcePastUnknownAssertion = (checker: ts.TypeChecker, node: ts.Expression): ts.Expression | null => {
  const outer = unwrapParens(node)
  if (!ts.isAsExpression(outer) && !ts.isTypeAssertionExpression(outer)) return null
  const inner = unwrapParens(outer.expression)
  if (!ts.isAsExpression(inner) && !ts.isTypeAssertionExpression(inner)) return null
  if ((checker.getTypeFromTypeNode(inner.type).flags & ts.TypeFlags.Unknown) === 0) return null
  return unwrapParens(inner.expression)
}

/**
 * Whether a type is, or is built from, a type parameter -- a hole rather than one layout.
 *
 * BOTH argument lists, always -- never chosen by the presence of `target`. An
 * instantiated ANONYMOUS type -- a mapped alias like `Record<K, V>` or tsc's
 * `Mutable<T>` -- has a `target` (the open anonymous type it was instantiated
 * from) and NO `typeArguments`, so picking one list by whether `target` is set
 * read `Record<string, WithCount<T>[]>` as mentioning nothing: `target` is
 * defined (the mapped type's own open shape), so the old code took
 * `typeArguments` (empty for a mapped instantiation) and never looked at
 * `aliasTypeArguments`, where `T` actually lives. `specialization.ts`'s
 * `containsHole` documents the identical gotcha and already combines both
 * lists; this is the same fix; see its comment for the tsc self-compile
 * regression that shape caused there.
 *
 * The consequence here was narrower but still wrong at the source:
 * `producers/invocations.ts`'s `parameterShapeOf` asks this to decide whether
 * a parameter's own resolved-signature TYPE has already closed a hole its
 * DECLARATION still states open. For a generic class's constructor parameter
 * typed `Record<string, WithCount<T>[]>`, the declared side read as "mentions
 * nothing" (this bug), so `substituted` was false and the OPEN, unsubstituted
 * declared type was published as the parameter's carrier for every call --
 * identical for `new Box<number>(...)` and `new Box<string>(...)` alike, since
 * both read the one shared, uninstantiated parameter declaration. That is
 * `test/runtime/generic-function-composite-filling-in-class-copy.ts`'s
 * `array-object@<hash>` refusal: an unresolved composite masquerading as a
 * structural type because nothing upstream believed it still had a hole.
 */
export const mentionsTypeParameter = (type: ts.Type, depth = 0): boolean => {
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true
  if (depth > 6) return false
  if (type.isUnionOrIntersection()) return type.types.some((member) => mentionsTypeParameter(member, depth + 1))
  const reference = type as ts.TypeReference
  const args = [...(reference.typeArguments ?? []), ...(type.aliasTypeArguments ?? [])]
  return args.some((argument) => mentionsTypeParameter(argument, depth + 1))
}

/**
 * Whether a stated return deliberately asserts an incompatible physical value
 * through `unknown`. TypeScript accepts this as an escape hatch, but the
 * assertion emits no runtime conversion; native storage must therefore follow
 * the expression beneath it rather than reinterpret one object layout as an
 * unrelated class.
 */
const hasPhysicalReturnAssertion = (checker: ts.TypeChecker, declaration: ReturnCandidateDeclaration): boolean => {
  if (!declaration.type || !declaration.body) return false
  const stated = checker.getTypeFromTypeNode(declaration.type)
  // `return { kind, type } as unknown as T` with `T` the function's OWN type
  // parameter (TypeScript's `createBaseNode<T extends Node>`, `nodeFactory.ts`
  // throughout): the target is a hole every copy fills differently, not one
  // physical layout the literal could contradict. `isTypeAssignableTo` says
  // no for any hole, so reading it as a physical mismatch bound the return
  // to the literal's shape and made every copy's call disagree with its own
  // `T` -- the copy's filling is the authority, and the literal converts to
  // it at the return, per copy, where the conversion can be judged.
  if (mentionsTypeParameter(stated)) return false
  let found = false
  const walk = (node: ts.Node): void => {
    if (found || (node !== declaration.body && isScopeBoundary(node))) return
    if (ts.isReturnStatement(node) && node.expression) {
      const source = sourcePastUnknownAssertion(checker, node.expression)
      if (source && !checker.isTypeAssignableTo(checker.getTypeAtLocation(source), stated)) found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(declaration.body)
  return found
}

/**
 * Whole-program census of what every unannotated function actually returns.
 *
 * `parameters` is the ALREADY-SETTLED output of `censusParameterBindings`
 * (or `emptyParameterBindingCensus` when none is available) -- settled
 * before this runs, never re-opened by it. See this module's header comment
 * for why a single ordered pass was chosen over re-deriving a joint
 * fixpoint, and what that choice cannot see.
 */
export const censusReturnBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  /**
   * The array/collection census for THIS SAME round -- see `frontend.ts`'s
   * `compose`, which now computes `collections` from the prior round's
   * settled parameter view and hands it to every census in the CURRENT
   * round, this one included, rather than only to `createStructuralMapper`
   * after the whole fixpoint has already finished with it.
   *
   * Consulted at exactly one point below (the element-access arm of
   * `resolveExpr`), as `collections.arrayElementForRead` -- the element type
   * of a tracked accumulator array, asked at the RECEIVER expression rather
   * than the whole indexed read. `findLightProbeGrid( volumes, object )`
   * (`WebGLRenderer.js`) is the exemplar: `return volumes[ 0 ]` where
   * `volumes` is an unannotated parameter whose real evidence is a
   * module-scope `const lightProbeGridArray = []` filled by `.push` calls
   * elsewhere -- exactly what `collection-bindings.ts`'s array census exists
   * to type, and exactly the shape this module's own resolvers could not
   * reach before, because that census ran only after this whole fixpoint
   * settled. `emptyCollectionBindingCensus` (every caller before this
   * change) makes this identical to the previous behaviour.
   */
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  /**
   * The whole-program value-flow index -- the ONE walk that states where every
   * write is. This module's own two private write-discovery walks
   * (`assignmentsBySymbol`, `containerSetsBySymbol`) read their edges from it
   * rather than re-deriving them; see `flow/model.ts`. An edge-SOURCE swap: the
   * policy below (which writes are evidence, how they join) is unchanged.
   */
  flow: ValueFlowIndex,
  /**
   * The same-round property-bag census. Consulted at exactly one point below
   * (the element/property-access arm of `resolveExpr`), as `slotTypeAt` --
   * the ONE question about a bag this module can consume, since a slot's own
   * type is a plain `ts.Type` even though the bag's shape is not. See that
   * accessor's own header for the refusal it removes.
   */
  bags: ObjectBagCensus = emptyObjectBagCensus
): ReturnBindingCensus => {
  const candidates: ReturnCandidateDeclaration[] = []
  /** Stated functions whose explicit unknown assertion changes only the type-system view, never runtime storage. */
  const physicalAssertionReturns = new Set<ReturnCandidateDeclaration>()
  /** The annotation a STATED candidate may only narrow WITHIN -- see `statedReturnBound`. Absent for a candidate admitted for having no statement at all. */
  const statedBounds = new Map<ReturnCandidateDeclaration, ts.Type>()
  /** The subset of `bound` that came from a stated annotation -- see `statedTypeAt`. */
  const statedReturns = new Map<ReturnCandidateDeclaration, ts.Type>()
  /** Requirements captured while deriving an accepted declaration return. */
  const returnRequirements = new Map<ReturnCandidateDeclaration, readonly IntrinsicProtocolRequirement[]>()
  /** Function expressions whose return convention is the slot they are written into -- see `contextualReturnTypeOf`. */
  const contextualReturns = new Map<ReturnCandidateDeclaration, ts.Type>()
  const visit = (node: ts.Node): void => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !hasStatedReturnType(checker, node) && node.body !== undefined) {
      const contextual = contextualReturnTypeOf(checker, node)
      if (contextual) contextualReturns.set(node, contextual)
    }
    if (isReturnCandidateKind(node) && !hasStatedReturnType(checker, node) && node.body !== undefined) {
      const signature = checker.getSignatureFromDeclaration(node)
      const returned = signature ? checker.getReturnTypeOfSignature(signature) : null
      // `isAnyType` alone is a trap here, and exactly the one `parameter-
      // bindings.ts`'s `isUnannotated` documents: relaxing `hasStatedReturn
      // Type` above admits a declaration whose SIGNATURE still reports the
      // stated `object`/`{}`/`object | null`, which is not `any` and would be
      // silently re-excluded one line later -- the gate would move by exactly
      // zero. The two questions have to be answered the same way in both
      // places, so this asks `annotationStatesNothing` of the resolved return
      // type as well.
      if (returned && (isAnyType(returned) || annotationStatesNothing(checker, node, returned))) candidates.push(node)
    }
    // ...and the third shape: a STATED return type that is only an upper
    // bound. `hasStatedReturnType` above turns it away, correctly, for the
    // question that gate asks (is there an annotation at all); this asks the
    // different question `statedReturnBound` states, and a declaration
    // admitted here is held to its annotation rather than replacing it.
    if (isReturnCandidateKind(node)) {
      if (hasPhysicalReturnAssertion(checker, node)) {
        physicalAssertionReturns.add(node)
        candidates.push(node)
      }
      const stated = statedReturnBound(checker, node)
      if (stated) {
        statedBounds.set(node, stated)
        candidates.push(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visit)

  /**
   * Whole-program evidence this module used to gather for itself with a
   * private walk, rather than asking `parameter-bindings.ts` for it: every
   * `symbol = expr` write (its own declaration's initializer included), and
   * every value argument passed to a `symbol.set(key, value)` call. Neither
   * is exposed by `ParameterBindingCensus` -- `parameters.typeAt` answers
   * from that file's PUBLISHING resolver, which deliberately refuses a cell
   * with no initializer (its own header comment: propagating a late-filled
   * write to the cell's own DECLARATION manufactured 12 conversion
   * obligations when tried). A `return` reads a cell downstream of every one
   * of its writes, the same shape of read `parameter-bindings.ts`'s internal
   * (private, un-exported) PROPAGATING resolver already trusts for an
   * argument -- so re-deriving that narrower, read-site-only slice here is
   * not a second authority disagreeing with the first; it is the one
   * authority's own published answer plus what it already told the world it
   * cannot safely publish at a declaration.
   *
   * Both shapes now come from the shared value-flow index instead of a
   * second, private walk of this file's own -- an edge-SOURCE swap, not a
   * policy change. `identifierWritesOf` asks for exactly the two edges the
   * old walk recognised (`declaration-initializer`, `identifier-assignment`).
   *
   * ⛔ Deliberately NOT widened to admit `object-assign` here (H3 in the
   * fleet brief), and `containerSetValuesFor` below is deliberately NOT
   * widened past its original identifier+two-argument restriction (RET note
   * 12). ADDENDUM 3 to the fleet brief: the index's `object-assign` and
   * `collection-value` edges are matched by LIBRARY MEMBER SPELLING
   * (`Object.assign`, `.set`), which is the same defect this campaign is
   * closing one layer down -- `fCALL` owns `flow/` and is replacing both with
   * a generic `call(callee, args) -> value` primitive where write-through is
   * a property of the resolved callee (via protocol data or the callee's own
   * body), never of its name. Hand-widening either edge here would be
   * patching the consumer instead of fixing the authority. Once that lands,
   * this module reads whatever it publishes with no change of its own.
   */
  const identifierWritesOf = (symbol: ts.Symbol): readonly ts.Expression[] => {
    const writes: ts.Expression[] = []
    for (const write of flow.writesToSymbol(symbol)) {
      if (
        write.slot === 'whole' &&
        write.value !== null &&
        (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment')
      ) {
        writes.push(write.value)
      }
    }
    return writes
  }

  /**
   * The VALUE half of every `<id>.set(key, value)` call on this symbol --
   * receiver a plain identifier, exactly two arguments, the identical
   * restriction the private walk this replaced applied (RET note 12).
   *
   * ⛔ Deliberately NOT widened past that restriction here -- see
   * `identifierWritesOf`'s own comment (ADDENDUM 3): the index's
   * `collection-value` edge is matched by the library method spelling
   * `.set`, which `fCALL` is replacing with a generic `call`-primitive whose
   * write-through is a property of the resolved callee. Hand-widening the
   * RECEIVER shape this reads would be patching the consumer instead of
   * fixing the authority.
   */
  const containerSetValuesOf = (symbol: ts.Symbol): readonly ts.Expression[] => {
    const writes: ts.Expression[] = []
    for (const write of flow.writesToSymbol(symbol)) {
      if (
        write.edge === 'collection-value' &&
        write.value !== null &&
        ts.isCallExpression(write.site) &&
        write.site.arguments.length === 2
      ) {
        writes.push(write.value)
      }
    }
    return writes
  }

  const bound = new Map<ReturnCandidateDeclaration, ts.Type>()
  /** The synthesized union arms for a function whose `return`s disagree but disjointly -- see `computeReturnType`. */
  const unionArms = new Map<ReturnCandidateDeclaration, readonly ts.Type[]>()
  const refusalOf = new Map<ReturnCandidateDeclaration, CensusRefusal>()
  const resolving = new Set<ReturnCandidateDeclaration>()
  /** Cycle guards for the two evidence lookups above -- a variable or a container that (transitively) reads its own write refuses rather than loops. */
  const resolvingBindings = new Set<ts.Symbol>()
  const resolvingContainers = new Set<ts.Symbol>()
  /** Cycle guard for `resolveBindingElement` below -- a nested pattern (`{a: {b}}`) recurses through its own outer element and must refuse rather than loop. */
  const resolvingElements = new Set<ts.BindingElement>()

  /** The checker's own answer at this node, when it says something usable. */
  /** The checker's own answer, when usable -- `annotationStatesNothing` beside `isUnusableEvidence` for the reason `field-bindings.ts`'s `known` documents: a vacuous type dominates a `widestOf` join. */
  const known = (node: ts.Node): ts.Type | null => {
    const type = objectAssignTargetType(checker, node) ?? checker.getTypeAtLocation(node)
    return isUnusableEvidence(type) || annotationStatesNothing(checker, node, type) ? null : type
  }

  /**
   * ⛔ ASK THE SHARED HELPER. This used to be a hand-rolled copy that called
   * `getPropertyOfType` on the receiver as given, and it was the fourth of four
   * census layers to answer "what is member X of T" -- the other three
   * (`local-bindings`, `field-bindings`, `parameter-bindings`) all delegate
   * here. The copy had drifted on both of `memberTypeOf`'s rules:
   *
   * - it never took `getNonNullableType`, so a receiver this very census stack
   *   had widened to `T | null` reported NO member at all;
   * - it never took `singleConventionAt`, so an overloaded member would have
   *   been answered in a shape the other three layers never produce.
   *
   * Measured: three's `WebGLBindingStates.js:52`, `function
   * createVertexArrayObject() { return gl.createVertexArray() }`. The composed
   * view types `gl` as `NativeWebGL2RenderingContext | null` and the whole call
   * as `NativeHandle`; this copy refused it `return-member-not-found`, so the
   * declaration got NO census return, `producers/invocations.ts` fell back to
   * the checker's `any`, and `validateInvocationResult` -- correctly -- failed
   * the producer for disagreeing with its own invocation result. The call and
   * its caller were withheld.
   */
  // The closed-family fallback is the parameter census's own rule, asked the
  // same way -- see `flow/class-family-member-read.ts`.
  const propertyTypeOf = (receiver: ts.Type, name: string, at: ts.Node): ts.Type | null =>
    memberTypeOf(checker, receiver, name, at, flow) ?? classFamilyMemberReadTypeOf(checker, flow, receiver, name, parameters)

  /** Records a more specific reason than the generic fallback, first dead-end wins. */
  const attribute = (owner: ReturnCandidateDeclaration, root: string): null => {
    if (!refusalOf.has(owner)) refusalOf.set(owner, censusRefusal('return', root, root, ownerOf(owner)))
    return null
  }

  /**
   * The iterable expression of a `for (const <name> of <expr>)` loop, when
   * `declaration` is that loop's own binding -- shared by the plain-
   * identifier case (`forOfElementType`, row 22) and the destructured-
   * binding case (`patternSourceExpression`). Duplicated from
   * `local-bindings.ts`'s identical helper rather than imported -- this
   * module's own resolvers are private and the two files do not share
   * internals, the same convention `isScopeBoundary`/`isReturnCandidateKind`
   * already follow (each documents which sibling file it mirrors). `for
   * await` is refused outright: it iterates a DIFFERENT protocol (the
   * async-iterable promise each step resolves), not the plain element this
   * reads.
   */
  const forOfIterableOf = (declaration: ts.VariableDeclaration): ts.Expression | null => {
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list)) return null
    const stmt = list.parent
    if (!ts.isForOfStatement(stmt) || stmt.initializer !== list || stmt.awaitModifier) return null
    return stmt.expression
  }

  /**
   * The element type a `for (const x of xs)` binding receives -- `xs`'s own
   * numeric index signature, with the same array-census fallback
   * (`collections.arrayElementForRead`) an ordinary element read already
   * falls back to when the receiver's own index signature is unusable. See
   * `local-bindings.ts`'s identical helper for the full rationale (row 22).
   */
  const forOfElementType = (declaration: ts.VariableDeclaration, owner: ReturnCandidateDeclaration): ts.Type | null => {
    const expression = forOfIterableOf(declaration)
    if (!expression) return null
    const iterable = knownOrResolve(expression, owner)
    if (!iterable) return null
    const nonNull = checker.getNonNullableType(iterable)
    const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
    if (indexed && !isUnusableEvidence(indexed)) return indexed
    return collections.arrayElementForRead(expression)
  }

  /** The actual SOURCE expression a top-level (non-nested) pattern reads from, when one syntactically exists -- used only for the array-census fallback below. */
  const patternSourceExpression = (pattern: ts.BindingPattern): ts.Expression | null => {
    const parent = pattern.parent
    if (!ts.isVariableDeclaration(parent)) return null
    return parent.initializer ?? forOfIterableOf(parent)
  }

  /**
   * The value flowing INTO a whole binding pattern -- see `local-bindings.
   * ts`'s identical `sourceTypeOfPattern` for the full rationale. Three
   * roots: a declaration's own initializer, a for-of loop's iterable
   * element, or (nested) the outer element's own resolved type. A
   * parameter's own pattern is PAR's cell, not this module's, and falls
   * through to `null` exactly as everywhere else this module does not own a
   * cell.
   */
  const sourceTypeOfPattern = (pattern: ts.BindingPattern, owner: ReturnCandidateDeclaration): ts.Type | null => {
    const parent = pattern.parent
    if (ts.isVariableDeclaration(parent)) {
      if (parent.initializer) return knownOrResolve(parent.initializer, owner)
      return forOfElementType(parent, owner)
    }
    if (ts.isBindingElement(parent)) return resolveBindingElement(parent, owner)
    return null
  }

  /**
   * `element`'s own resolved type -- the ONE recursive function answering
   * every binding-pattern leaf, object or array, nested or not, defaulted or
   * not (rows 14/15/16, and the destructured half of row 22). See
   * `local-bindings.ts`'s identical `resolveBindingElement` for the full
   * rationale; this copy threads `owner` through instead of memoizing,
   * because this module resolves a binding element freshly per `return`
   * that reads it rather than publishing a whole-program answer for it.
   */
  const resolveBindingElement = (element: ts.BindingElement, owner: ReturnCandidateDeclaration): ts.Type | null => {
    if (element.dotDotDotToken) return null
    if (resolvingElements.has(element)) return null
    resolvingElements.add(element)
    const pattern = element.parent
    const sourceType = sourceTypeOfPattern(pattern, owner)
    let ownType: ts.Type | null = null
    if (sourceType) {
      if (ts.isObjectBindingPattern(pattern)) {
        const key = element.propertyName ?? element.name
        ownType = ts.isIdentifier(key) ? propertyTypeOf(sourceType, key.text, element) : null
      } else {
        const nonNull = checker.getNonNullableType(sourceType)
        const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
        if (indexed && !isUnusableEvidence(indexed)) {
          ownType = indexed
        } else {
          const expr = patternSourceExpression(pattern)
          ownType = expr ? collections.arrayElementForRead(expr) : null
        }
      }
    }
    let result: ts.Type | null = null
    if (ownType) {
      if (element.initializer) {
        const defaultType = knownOrResolve(element.initializer, owner)
        result = defaultType ? (joinOfWrites(checker, [ownType, defaultType]) ?? ownType) : ownType
      } else {
        result = ownType
      }
    }
    resolvingElements.delete(element)
    return result
  }

  /**
   * What a local `let`/`var` cell holds, from EVERY write to it -- its
   * initializer (if any) and every later assignment `collectEvidence` found
   * -- joined via `joinOfWrites` exactly as two call sites or two `return`s
   * must agree elsewhere in this module. Only reached once `parameters.
   * typeAt` (the parameter census's own general resolver) has already
   * answered `null` for this identifier -- see this function's header
   * comment for why this is not a second, disagreeing authority.
   *
   * A write this module could not type is SILENCE, not a veto -- the exact
   * mirror of the rule `field-bindings.ts`, `local-bindings.ts` and
   * `parameter-bindings.ts` all now apply to their own write sets. This
   * helper used to require every write to speak and break on the FIRST one
   * that did not, so `let state = stateMap[ wireframe ];` (an untyped
   * element read from a plain object bag, real evidence of nothing) vetoed
   * the cell even where a later `state = createBindingState( ... )` gave a
   * real, checkable type -- three.js's `WebGLBindingStates.js:getBindingState`
   * is the exact case: the FIRST write's own failure attributed
   * `return-index-signature-absent` before the second write was ever asked.
   * `let lut = null;` filled in later by `lut = new DataTexture( ... )`
   * (`DFGLUTData.js`) is the same shape one level simpler -- `null` states an
   * absence, not a disagreeing type, which is exactly what `joinOfWrites`
   * (not the plainer `widestOf`) exists to recognise.
   *
   * Only a write typed `void`/`never` is a REAL fact refusing storage, so it
   * stays a veto; every other unresolved write is dropped from the join
   * rather than poisoning it, and a cell whose every write is silent still
   * answers `null` exactly as before.
   *
   * A destructured local (the identifier's sole declaration is a
   * `BindingElement`, never a `VariableDeclaration`) reaches its answer
   * through `resolveBindingElement` instead -- a different question
   * (`identifierWritesOf` finds no `declaration-initializer`/`identifier-
   * assignment` edge for a destructured name at all; the value flows in
   * through the pattern, not an assignment). A plain identifier with no
   * writes tries ONE more source before giving up: a `for (const x of xs)`
   * loop's own binding, row 22's non-destructured case.
   */
  const resolveLocalBinding = (identifier: ts.Identifier, owner: ReturnCandidateDeclaration): ts.Type | null => {
    const symbol = checker.getSymbolAtLocation(identifier)
    const declarations = symbol?.declarations
    const declaration = declarations && declarations.length === 1 ? declarations[0] : undefined
    if (!symbol || !declaration) return null
    if (ts.isBindingElement(declaration)) return resolveBindingElement(declaration, owner)
    if (!ts.isVariableDeclaration(declaration) || declaration.type) return null
    if (resolvingBindings.has(symbol)) return null
    resolvingBindings.add(symbol)
    const writes = identifierWritesOf(symbol)
    let result: ts.Type | null = null
    if (writes.length > 0) {
      const types: ts.Type[] = []
      let refused = false
      for (const write of writes) {
        const type = knownOrResolve(write, owner)
        if (type) {
          types.push(type)
          continue
        }
        if ((checker.getTypeAtLocation(write).flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) {
          refused = true
          break
        }
      }
      if (!refused && types.length > 0) result = joinOfWrites(checker, types)
    } else {
      result = forOfElementType(declaration, owner)
    }
    resolvingBindings.delete(symbol)
    return result
  }

  /**
   * The value type a `Map`/`WeakMap` instance holds, read from every
   * `.set(key, value)` call this program makes on it -- the identical
   * call-site-argument technique `parameter-bindings.ts`'s own
   * `agreedArgumentType` uses for a function parameter, asked about a
   * container's generic argument instead. Restricted to a receiver that is a
   * bare identifier: `this.properties.get(x)` names no single symbol this
   * census can gather every `.set` against, and is refused rather than
   * guessed at, same as everywhere else in this module.
   *
   * ⛔ Deliberately NOT widened to a general receiver here (RET note 12) --
   * see `containerSetValuesOf`'s own comment (ADDENDUM 3): the underlying
   * `.set`/`collection-value` edge is itself a library-spelling match that
   * `fCALL` is replacing; widening the receiver this reads before that lands
   * would be hand-widening a restriction the reduction is meant to dissolve
   * on its own.
   */
  const containerValueType = (receiver: ts.Expression, owner: ReturnCandidateDeclaration): ts.Type | null => {
    if (!ts.isIdentifier(receiver)) return null
    const symbol = checker.getSymbolAtLocation(receiver)
    if (!symbol) return null
    const sets = containerSetValuesOf(symbol)
    if (sets.length === 0) return null
    if (resolvingContainers.has(symbol)) return null
    resolvingContainers.add(symbol)
    const types: ts.Type[] = []
    let every = true
    for (const value of sets) {
      const type = knownOrResolve(value, owner)
      if (!type) {
        every = false
        break
      }
      types.push(type)
    }
    resolvingContainers.delete(symbol)
    return every ? widestOf(checker, types) : null
  }

  /**
   * The two standard receiver interfaces `.get(k)` reads `V | undefined` off,
   * resolved by declaration identity (`isStandardInterfaceType`) rather than
   * by the receiver type's own symbol NAME -- the bare `receiverType.symbol?.name`
   * compare this used to be admitted any user object declaring its own
   * `.get(k)` method (a cache, a registry, a Command-shaped API) as though it
   * were a `Map`/`WeakMap`, and answered a return type the program's actual
   * `.get` was never going to produce. `Set`/`WeakSet` are deliberately
   * absent -- neither has a `.get` to read.
   */
  const MAP_LIKE_RECEIVER_INTERFACES: readonly string[] = ['Map', 'WeakMap']

  /**
   * `X.get(k)`'s own result, when `X` is a `Map`/`WeakMap` instance this
   * program only ever writes one settled value type into -- read as
   * `V | undefined`, never bare `V`: a `Map`/`WeakMap` genuinely can miss,
   * and reporting `V` alone would be exactly the wrong-answer-is-worse-than-
   * boxed failure this whole module exists to avoid. `getNullableType` is
   * the checker's own public constructor for that union, not an invented
   * one.
   */
  const containerGetResultType = (node: ts.CallExpression, owner: ReturnCandidateDeclaration): ts.Type | null => {
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'get' || node.arguments.length !== 1) return null
    const receiver = node.expression.expression
    const receiverType = checker.getTypeAtLocation(receiver)
    if (!MAP_LIKE_RECEIVER_INTERFACES.some((name) => isStandardInterfaceType(checker, receiver, name, receiverType))) return null
    const value = containerValueType(receiver, owner)
    if (!value) return attribute(owner, 'return-depends-on-unwritten-container')
    return checker.getNullableType(value, ts.TypeFlags.Undefined)
  }

  const resolveExpr = (node: ts.Expression, owner: ReturnCandidateDeclaration): ts.Type | null => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return knownOrResolve(node.expression, owner)
    if (ts.isIdentifier(node)) {
      const bound = parameters.typeAt(node)
      if (bound) return bound
      // Not a bound parameter, and `parameters.typeAt`'s own general
      // resolver (which DOES answer plain variables too, when they have an
      // initializer) also came up empty -- most often because that resolver
      // deliberately refuses a cell with no initializer at all. Try this
      // module's OWN write-set read, which is safe to be more permissive
      // about exactly because a `return` is a downstream READ, never the
      // cell's own declaration -- see `resolveLocalBinding`'s header
      // comment.
      const local = resolveLocalBinding(node, owner)
      if (local) return local
      return attribute(owner, 'return-depends-on-unresolved-binding')
    }
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = knownOrResolve(node.expression, owner)
      if (!receiver) return bags.slotTypeAt(node) ?? attribute(owner, 'return-depends-on-unresolved-receiver')
      return propertyTypeOf(receiver, node.name.text, node) ?? bags.slotTypeAt(node) ?? attribute(owner, 'return-member-not-found')
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const receiver = knownOrResolve(node.expression, owner)
      if (!receiver) {
        // The receiver itself has no usable evidence -- try the array census
        // before refusing outright. `arrayElementForRead` answers from the
        // RECEIVER expression's own tracked identity, not from a type this
        // module ever had, so it is a genuinely new source of evidence, not
        // a second guess at one already tried.
        const element = collections.arrayElementForRead(node.expression)
        if (element) return element
        const slot = bags.slotTypeAt(node)
        if (slot) return slot
        return attribute(owner, 'return-depends-on-unresolved-receiver')
      }
      // ⛔ ASK THE SHARED HELPERS -- the identical arm `parameter-bindings.ts`
      // already runs for the same expression. This module's copy accepted only
      // a STRING literal key and refused every other key outright, so the two
      // mirror censuses answered one question ("what does an element read
      // produce") two ways: `x[ 0 ]` is a named member spelled with brackets
      // over there and `return-expression-kind-not-modelled` here, and a
      // runtime key was resolved from the receiver's own index signature over
      // there and refused here.
      //
      // Neither half widens anything. `literalMemberNameOf` covers exactly the
      // literal keys that ARE names; `indexedTypeOf` reads the receiver's own
      // index signature and nothing else, answering `null` -- refusal
      // preserved -- for a receiver that declares none. An empty `{}` property
      // bag therefore still refuses here, which is correct: that value's
      // carrier is the dynamic-property sidecar's question, not this census's.
      const name = literalMemberNameOf(node)
      if (name !== null) return propertyTypeOf(receiver, name, node) ?? attribute(owner, 'return-member-not-found')
      const key = knownOrResolve(node.argumentExpression, owner)
      if (!key) return attribute(owner, 'return-depends-on-unresolved-index-key')
      // A RESOLVED receiver with no index signature of its own -- `never[]`,
      // most often -- is the other half of the same gap: the array census
      // knows the real element type from the program's `.push`/indexed-write
      // evidence, which the receiver's own (too-narrow) type does not state.
      return (
        indexedTypeOf(checker, receiver, key, node, flow, parameters) ??
        collections.arrayElementForRead(node.expression) ??
        bags.slotTypeAt(node) ??
        attribute(owner, 'return-index-signature-absent')
      )
    }
    if (ts.isCallExpression(node)) {
      const containerGet = containerGetResultType(node, owner)
      if (containerGet) return containerGet
    }
    if (ts.isNewExpression(node) && thisConstructorFamilyOf(checker, flow, node.expression) !== null) {
      // `new this.constructor(...)` -- three's `clone() { return new
      // this.constructor().copy( this ) }` idiom. `this.constructor`'s own
      // static type is the inherited `Object.prototype.constructor: Function`,
      // which the checker gives no construct signature, so the generic
      // "resolve the callee's own type, ask its signatures" path below always
      // refused here (`return-depends-on-unresolved-callee`) no matter which
      // family member `this` actually runs on -- and a `clone()` whose OWN
      // return type this census cannot state makes every read off a cloned
      // value (`clonedA.x`) opaque, which is what widens the host-mutation
      // census to `*` well past this one call. `thisConstructorFamilyOf`
      // already proved every family member's `constructor` slot is original,
      // so the construction is self-preserving: its result is exactly
      // whatever type `this` itself carries here, the same answer TypeScript
      // gives `this` inside an instance member.
      const access = unwrapErasedExpression(node.expression)
      const thisType = ts.isPropertyAccessExpression(access) ? checker.getTypeAtLocation(unwrapErasedExpression(access.expression)) : null
      if (thisType) return thisType
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const invariant = overloadInvariantReturnTypeAt(checker, node, (operand) => knownOrResolve(operand, owner))
      if (invariant) return invariant
      const callee = knownOrResolve(node.expression, owner)
      if (!callee) return attribute(owner, 'return-depends-on-unresolved-callee')
      const constructed = ts.isNewExpression(node) ? callee.getConstructSignatures() : []
      const signatures = constructed.length > 0 ? constructed : callee.getCallSignatures()
      if (signatures.length === 0) return attribute(owner, 'return-depends-on-unresolved-callee')
      if (signatures.length !== 1) return attribute(owner, 'return-depends-on-overloaded-call')
      const signature = signatures[0] as ts.Signature
      const unwrapped = ts.isCallExpression(node) ? unwrapExplicitThisCall(checker, node) : null
      const returned = explicitThisCallReturnType(signature, unwrapped ? knownOrResolve(unwrapped.callee, owner) : null)
      if ((returned.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) return attribute(owner, 'return-depends-on-void-call')
      if (!isAnyType(returned)) return returned
      const declared = signature.declaration
      if (!declared || !isReturnCandidateKind(declared)) return attribute(owner, 'return-depends-on-unmodelled-callee')
      if (declared === owner || resolving.has(declared)) {
        refusalOf.set(owner, censusRefusal('return', 'return-recursive', 'return-recursive', ownerOf(owner)))
        return null
      }
      return resolveDeclarationReturn(declared)
    }
    // A ternary, a binary/logical expression, a template -- shared with
    // `parameter-bindings.ts` via `derived-expression-type.ts` rather than
    // answered a second way here. `read` is this file's own `knownOrResolve`,
    // so every operand still goes through THIS module's cycle guards and
    // evidence, not a second, independent walk.
    const derived = derivedExpressionType(checker, node, (operand) => knownOrResolve(operand, owner))
    if (derived) return derived
    // An object/array literal's own type is virtually always usable directly
    // from the checker (a literal's TOP type is never itself flagged `any`,
    // only its members can be) -- `known(node)`, tried before this function
    // is ever reached, already answers those. What is left here -- a
    // computed element access, `this`, a spread, anything else -- is refused
    // rather than guessed at: shape decisions for a literal specifically
    // belong to `structural-layout-type.ts`'s contextual-type logic, which
    // this module does not own and must not re-derive a second copy of.
    return attribute(owner, 'return-expression-kind-not-modelled')
  }

  /**
   * `known(node) ?? resolveExpr(node, owner)`, except at a `return`'s own
   * `as`/`<T>` cast: there the checker's answer at the CAST is taken as-is
   * and never read past, exactly as this module's header comment describes.
   * `x as any` therefore still refuses -- the cast said `any`, and honouring
   * a statement is not the same as improving on it.
   */
  const knownOrResolve = (node: ts.Expression, owner: ReturnCandidateDeclaration): ts.Type | null => {
    const unwrapped = unwrapParens(node)
    if (ts.isAsExpression(unwrapped) || ts.isTypeAssertionExpression(unwrapped)) {
      const physical = physicalAssertionReturns.has(owner) ? sourcePastUnknownAssertion(checker, unwrapped) : null
      return physical ? knownOrResolve(physical, owner) : known(unwrapped)
    }
    // A CELL A CENSUS NARROWED WITHIN ITS OWN STATEMENT OUTRANKS THE CHECKER
    // here, for the reason `field-bindings.ts` states at the identical hop:
    // the checker keeps answering the annotation in full, so reading it makes
    // the returned value's carrier disagree with the carrier of the cell it
    // was just read out of. hono's `get [GET_MATCH_RESULT](): Result<[unknown,
    // RouterRoute]> { return this.#matchResult }` is the measured case -- the
    // field census had already narrowed that field, and the checker had not.
    return parameters.statedTypeAt(node) ?? known(node) ?? resolveExpr(node, owner)
  }

  const computeReturnType = (declaration: ReturnCandidateDeclaration): ts.Type | null => {
    if ('asteriskToken' in declaration && declaration.asteriskToken) {
      refusalOf.set(declaration, censusRefusal('return', 'generator-function', 'generator-function', ownerOf(declaration)))
      return null
    }
    if (hasAsyncModifier(declaration)) {
      refusalOf.set(declaration, censusRefusal('return', 'async-function', 'async-function', ownerOf(declaration)))
      return null
    }
    const body = declaration.body
    if (!body) {
      refusalOf.set(declaration, censusRefusal('return', 'no-body', 'no-body', ownerOf(declaration)))
      return null
    }
    if (!ts.isBlock(body)) return knownOrResolve(body, declaration)

    const collected: ts.Type[] = []
    let refused = false
    let sawReturn = false
    let sawBareReturn = false
    const walk = (node: ts.Node): void => {
      if (refused) return
      if (node !== body && isScopeBoundary(node)) return
      if (ts.isReturnStatement(node)) {
        sawReturn = true
        if (!node.expression) {
          sawBareReturn = true
          refused = true
          return
        }
        const type = knownOrResolve(node.expression, declaration)
        if (!type) {
          refused = true
          return
        }
        collected.push(type)
        return
      }
      ts.forEachChild(node, walk)
    }
    ts.forEachChild(body, walk)

    if (!sawReturn) {
      refusalOf.set(declaration, censusRefusal('return', 'no-return-statement', 'no-return-statement', ownerOf(declaration)))
      return null
    }
    if (sawBareReturn) {
      refusalOf.set(declaration, censusRefusal('return', 'bare-return', 'bare-return', ownerOf(declaration)))
      return null
    }
    if (refused) {
      if (!refusalOf.has(declaration)) {
        refusalOf.set(
          declaration,
          censusRefusal('return', 'return-expression-unresolved', 'return-expression-unresolved', ownerOf(declaration))
        )
      }
      return null
    }
    if (!definitelyReturns(body.statements)) {
      refusalOf.set(
        declaration,
        censusRefusal('return', 'implicit-undefined-return-path', 'implicit-undefined-return-path', ownerOf(declaration))
      )
      return null
    }
    const widest = widestOf(checker, collected)
    if (widest) return widest
    // No single covering type. Before refusing, ask whether the disagreement
    // is itself a sound answer -- see `disjointUnionMembersOf`'s own comment
    // for what "sound" means here.
    const joined = joinOfWrites(checker, collected)
    const arms = disjointUnionMembersOf(checker, collected)
    if (arms) unionArms.set(declaration, arms)
    // ONE authority answers "what single type does a cell several values reach
    // hold", and this census was asking only the narrower half of it.
    // `widestOf` above picks a COVERING MEMBER of the set it is handed, so a
    // function whose returns are all literals of one primitive -- three's
    // `WebGLUtils.convert`, sixty-odd `readonly UNSIGNED_BYTE = 0x1401`
    // constants read off the WebGL context, plus `null` -- has no member that
    // covers the rest and refused outright. `joinOfWrites` is the whole
    // question: covering member, else the present arms' join with the nullish
    // ones split off, else that join with the literal forms widened. Asked
    // LAST, so a set whose disagreement is itself the answer still becomes a
    // tagged union instead of being flattened to its base type.
    else if (joined !== null) return joined
    // NAME THE ARMS. "returns-disagree" alone says a set of types has no
    // covering member and no sound disjoint reading, which is the one fact a
    // reader already knows; WHICH types they are is the whole of what decides
    // whether the fix belongs to a return arm, to `widestOf`, or to
    // `disjointUnionMembersOf`. three's `WebGLUtils.convert` refused here with
    // no way to tell those apart.
    else
      refusalOf.set(
        declaration,
        censusRefusal(
          'return',
          'returns-disagree',
          `returns-disagree: ${[...new Set(collected.map((type) => checker.typeToString(type)))].join(' | ')}`,
          ownerOf(declaration)
        )
      )
    return null
  }

  /**
   * A STATED candidate is held to its statement, exactly as
   * `parameter-bindings.ts` holds a stated parameter and `field-bindings.ts` a
   * stated field: the returned type has to be assignable to the annotation
   * (the floor) AND differ from it only where the annotation said nothing. A
   * synthesized disjoint union is refused outright -- those arms are a member
   * list for `table.intern`, not a `ts.Type` the statement can be tested
   * against.
   */
  const heldToStatement = (declaration: ReturnCandidateDeclaration, stated: ts.Type, result: ts.Type | null): ts.Type | null => {
    if (unionArms.has(declaration)) {
      unionArms.delete(declaration)
      refusalOf.set(
        declaration,
        censusRefusal('return', 'stated-return-synthesized-union', 'stated-return-synthesized-union', ownerOf(declaration))
      )
      return null
    }
    if (!result) return null
    if (carriesUnsubstitutedGeneric(checker, result)) {
      refusalOf.set(declaration, censusRefusal('return', 'stated-return-open-generic', 'stated-return-open-generic', ownerOf(declaration)))
      return null
    }
    if (!checker.isTypeAssignableTo(result, stated)) {
      refusalOf.set(
        declaration,
        censusRefusal('return', 'stated-return-not-assignable', 'stated-return-not-assignable', ownerOf(declaration))
      )
      return null
    }
    if (!narrowsOnlyUnstatedPositions(checker, declaration, stated, result)) {
      refusalOf.set(
        declaration,
        censusRefusal('return', 'stated-return-narrows-a-stated-position', 'stated-return-narrows-a-stated-position', ownerOf(declaration))
      )
      return null
    }
    statedReturns.set(declaration, result)
    return result
  }

  const resolveDeclarationReturn = (declaration: ReturnCandidateDeclaration): ts.Type | null => {
    const already = bound.get(declaration)
    if (already) {
      const requirements = returnRequirements.get(declaration)
      if (requirements) deferredIntrinsicProtocolLedgerOf(flow)?.include(requirements)
      return already
    }
    if (unionArms.has(declaration)) {
      const requirements = returnRequirements.get(declaration)
      if (requirements) deferredIntrinsicProtocolLedgerOf(flow)?.include(requirements)
      return null
    }
    if (refusalOf.has(declaration)) return null
    resolving.add(declaration)
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    const infer = () => {
      const computed = computeReturnType(declaration)
      const stated = statedBounds.get(declaration)
      return stated ? heldToStatement(declaration, stated, computed) : computed
    }
    const captured = ledger?.capture(infer)
    const result = captured?.value ?? (ledger ? null : infer())
    resolving.delete(declaration)
    // A disjoint synthesized union is an accepted return answer too; its
    // structural arms are published separately, but any deferred obligations
    // discovered while deriving those arms must survive and replay exactly as
    // an ordinary bound return does.
    if (result || unionArms.has(declaration)) {
      if (result) bound.set(declaration, result)
      if (captured && captured.requirements.length > 0) {
        returnRequirements.set(declaration, captured.requirements)
        ledger?.include(captured.requirements)
      }
    } else if (!refusalOf.has(declaration) && !unionArms.has(declaration)) {
      refusalOf.set(
        declaration,
        censusRefusal('return', 'return-expression-unresolved', 'return-expression-unresolved', ownerOf(declaration))
      )
    }
    return result
  }

  for (const candidate of candidates) resolveDeclarationReturn(candidate)
  // The slot's convention outranks the body's own join: a body whose returns
  // this census settled to a NARROWER type than the slot's is still called
  // through the slot, and its `return`s widen into the slot's type exactly as
  // they would into an annotation saying the same thing.
  for (const [declaration, returned] of contextualReturns) {
    bound.set(declaration, returned)
    unionArms.delete(declaration)
    refusalOf.delete(declaration)
    returnRequirements.delete(declaration)
  }
  deferredIntrinsicProtocolLedgerOf(flow)?.replace('return-bindings', [...returnRequirements.values()].flat())

  const refusals: CensusRefusal[] = []
  for (const candidate of candidates) {
    if (bound.has(candidate) || unionArms.has(candidate)) continue
    // Every candidate that reaches `resolveDeclarationReturn` records its own
    // refusal on the way out (`computeReturnType`, `heldToStatement`, and the
    // fallback in `resolveDeclarationReturn` itself all set one before
    // returning `null`), so this fallback is defensive rather than a real
    // path -- kept so a future gap in that coverage still publishes a located
    // refusal instead of a silent one.
    refusals.push(refusalOf.get(candidate) ?? censusRefusal('return', 'unresolved', 'unresolved', ownerOf(candidate)))
  }

  return {
    typeAt: (node) => {
      if (isReturnCandidateKind(node)) return bound.get(node) ?? null
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration
        if (declaration && isReturnCandidateKind(declaration)) return bound.get(declaration) ?? null
      }
      return null
    },
    unionArmsAt: (node) => {
      if (isReturnCandidateKind(node)) return unionArms.get(node) ?? null
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration
        if (declaration && isReturnCandidateKind(declaration)) return unionArms.get(declaration) ?? null
      }
      return null
    },
    statedTypeAt: (node) => {
      if (statedReturns.size === 0) return null
      if (isReturnCandidateKind(node)) return statedReturns.get(node) ?? null
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration
        if (declaration && isReturnCandidateKind(declaration)) return statedReturns.get(declaration) ?? null
      }
      return null
    },
    boundCount: bound.size + unionArms.size,
    refusals,
    refusalOf: (declaration) => (isReturnCandidateKind(declaration) ? (refusalOf.get(declaration)?.reason ?? null) : null)
  }
}

/**
 * A `ParameterBindingCensus`-shaped view that answers from BOTH censuses:
 * `parameters`'s own answer first (a parameter binding is the more direct
 * fact), the return census otherwise.
 *
 * This is the seam meant for `frontend.ts`, which is the one place that
 * builds `ParameterBindingCensus` and hands it to `createStructuralMapper`
 * (`structural.ts`) -- neither of which this module owns or edits. Composed
 * this way, `structural-layout-type.ts`'s existing `parameters.typeAt(node)`
 * fallback (already-landed code, untouched by this module) starts answering
 * for a call site this census resolves too, with NO edit needed to either
 * file: swap `frontend.ts`'s
 *
 *   const parameters = censusParameterBindings(compiled.checker, compiled.sourceFiles)
 *
 * for
 *
 *   const parameters = withReturnBindings(
 *     compiled.checker,
 *     compiled.sourceFiles,
 *     censusParameterBindings(compiled.checker, compiled.sourceFiles)
 *   )
 *
 * and the rest of the pipeline is unchanged. Exported so that edit, when
 * made by whoever owns `frontend.ts`, is one line.
 */
/**
 * The composed view AND the census inside it, for the one caller that needs
 * both halves to be the SAME instance.
 *
 * `withReturnBindings` builds a census and hides it, which is right for every
 * consumer that only ever asks a node. It is wrong for a consumer that has to
 * agree with one: `producers/invocations.ts` reads a call's RESULT through the
 * composed view (`context.types.typeAt(node)`) and needs this census's answer
 * for the same call's CALLEE, and building a second census to ask would
 * reintroduce exactly the two-authority split it is there to close -- two
 * fixpoints over the same program can settle differently, and the one that
 * answers the result would not be the one that answers the signature.
 *
 * So the instance is handed out rather than reconstructed. `withReturnBindings`
 * stays the seam for everyone else and is now this function's `view`.
 */
export const composeReturnBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus,
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  /** The whole-program value-flow index -- see `censusReturnBindings`'s own parameter. */
  flow: ValueFlowIndex,
  /** The same-round property-bag census -- see `censusReturnBindings`'s own parameter. */
  bags: ObjectBagCensus = emptyObjectBagCensus
): { readonly view: ParameterBindingCensus; readonly returns: ReturnBindingCensus } => {
  const returns = censusReturnBindings(checker, files, reachable, parameters, collections, flow, bags)
  // Both sides already publish `CensusRefusal[]` -- a plain concat forwards
  // every one of the upstream census's refusals undiminished, rather than
  // collapsing them into counts the way this composition used to (`return:
  // ${reason}` over a count map). Nothing is owner-less any more, so there is
  // nothing left for a count to summarize that the list itself does not
  // already say better.
  const refusals: readonly CensusRefusal[] = [...parameters.refusals, ...returns.refusals]
  return {
    view: {
      ...parameters,
      typeAt: (node) => parameters.typeAt(node) ?? returns.typeAt(node),
      statedTypeAt: (node) => parameters.statedTypeAt(node) ?? returns.statedTypeAt(node),
      unionArmsAt: (node) => parameters.unionArmsAt(node) ?? returns.unionArmsAt(node),
      boundCount: parameters.boundCount + returns.boundCount,
      refusals
    },
    returns
  }
}

// `withReturnBindings` -- the two-line `.view` shim over `composeReturnBindings`
// -- is deliberately absent. It had no caller, and its signature omitted the
// value-flow index entirely, so anyone reaching for it would have composed a
// return census that silently saw no writes at all. That is not hypothetical:
// the identical omission at `frontend.ts`'s `withLocalBindings` call site left
// the local census blind for its whole existence, and the census reported it as
// 3201 program facts (`local:no-writes`, half of every refusal in the
// compiler) rather than as one missing argument. Compose explicitly.
