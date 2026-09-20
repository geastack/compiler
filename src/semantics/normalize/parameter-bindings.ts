import { isRealCallableDeclaration, isModuleExportedDeclaration, isTypePositionReference, runtimeParametersOf } from './flow/targets.js'
import { inProgramImportReferencesOf } from './flow/export-importers.js'
import ts from 'typescript'
import { implicitArgumentsSlotOf } from './implicit-arguments.js'
import {
  implicitArgumentsReadTypeAt,
  inferImplicitArgumentsTuple,
  type ImplicitArgumentsInference,
  type ImplicitArgumentsTuple
} from './implicit-arguments-tuple.js'
import { censusArgumentsObjects, type ArgumentsObjectCensus } from './arguments-objects.js'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'
import type { ExplicitThisCallFrame, FlowInvocationOperands, ValueFlowIndex } from './flow/model.js'
import { classFamilyMemberReadTypeOf } from './flow/class-family-member-read.js'
import { omissionStatedTypeOf, statedParameterWithOmission } from './omitted-stated-parameter.js'
import { indexValueFlow } from './flow/value-flow.js'
import { closedArrayCalleeAuthorityOf, hasClosedMemberCallableUses } from './flow/callable-reach.js'
import type { CallableArrayOriginAuthority } from './flow/callable-array-origins.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'
import {
  callbackContractParameterType,
  callbackParameterContractsFor,
  type CallbackParameterContract
} from './callback-parameter-contracts.js'
import {
  declaredClosedTupleRestElementsOf,
  impliedPatternElementOfArms,
  impliedPatternPositionPresentEverywhere
} from './parameter-slot.js'
import { iteratorYieldTypesOf } from './producers/iteration-yield.js'
import {
  type AliasEvidence,
  annotationStatesNothing,
  exactEmptyObjectLiteralType,
  isNullishType,
  containsUnstatedPosition,
  derivedExpressionType,
  indexAliasEvidence,
  indexedTypeOf,
  explicitThisCallReturnType,
  overloadInvariantReturnTypeAt,
  indexNamedCallables,
  isStandardInterfaceType,
  isBindingOnlyReference,
  isCalleeOf,
  isTrackedCallable,
  isUnusableEvidence as statesNoStorage,
  carriesNoEvidence,
  disjointUnionMembersOf,
  disjointUnionTypeOf,
  joinOfWrites,
  jsDocTypeStatesNothing,
  literalMemberNameOf,
  narrowsOnlyUnstatedPositions,
  withoutUndefinedMember,
  memberTypeOf,
  objectAssignTargetType,
  nameOfCallable,
  synthesizedUnionArmsAt,
  widestOf,
  impliedPatternElementRootOf,
  impliedPatternParameterOf
} from './derived-expression-type.js'
import { isUnreducedTypeForm } from './unreduced-type-form.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * The type a parameter the program never annotated is actually called with.
 *
 * An unannotated parameter in a JavaScript file is typed `any` by the checker.
 * That answer describes where TypeScript looked, not what the program says:
 * TypeScript infers a parameter's type from its annotation and from nothing
 * else, and never from the arguments a call passes it. `function WebGLTextures(
 * _gl, extensions, state, ... )` is called exactly once in a program, from
 * `WebGLRenderer`, with seven arguments whose types are all known -- so the
 * types exist, they are simply not written down anywhere the checker consults.
 *
 * This is the same shape of question `structural-layout-type.ts` already
 * answers for an evolving array, one level up: the checker HAS the answer, and
 * this asks it at the location where the checker has one. It is emphatically
 * not the compiler inventing a type. Every type this module produces came out
 * of the checker -- either as an argument's own type at a call site, or as the
 * checker's answer about a member of one. What the module contributes is the
 * connection between the two, which is the part TypeScript does not make.
 *
 * ## Why this is not the boxed carrier's business
 *
 * `representation/model.ts` admits the dynamic carrier for exactly four
 * reasons, one of which is "the program itself declared `any`/`unknown` and
 * never narrowed it". A parameter with no annotation declared NOTHING. Filing
 * it under that reason reads the absence of a statement as a statement, which
 * is how 925 unannotated parameters in three.js's renderer came to cascade
 * 33,275 boxed carriers through a program whose types are all knowable.
 *
 * A parameter the program DID annotate `: any` is untouched here, and must be:
 * that one is a statement, and honoring it is the rule working.
 *
 * ## What it refuses
 *
 * Every refusal below leaves the parameter exactly as it is today -- `any`,
 * boxed -- because a wrong type is far worse than a boxed one:
 *
 * - a function whose name escapes to any position other than the callee of a
 *   call this census resolved back to it. A function held as a value can be
 *   called from somewhere this enumeration cannot see, and a parameter bound
 *   from a partial view of its callers is bound from a guess.
 * - a parameter assigned anywhere in its own body. Its value is then not the
 *   argument's, and the argument's type is not its type.
 * - call sites that disagree. Agreement is never tested by spelling. Two sites
 *   passing the same interned checker type describe one value shape; sites
 *   passing different types agree only when one of those types provably holds
 *   all the others, which the checker itself decides. Anything else is refused
 *   rather than merged into a union nobody wrote -- see `widestOf`.
 * - a rest parameter, a destructured parameter, and any argument whose own type
 *   is still `any` -- propagating `any` is what this exists to stop.
 */
export interface ParameterBindingCensus {
  /** Known executable destinations, including aliases and overrides. Positive evidence, not a proof that no opaque target exists. */
  readonly callTargetsAt?: (call: ts.CallExpression | ts.NewExpression) => readonly ts.SignatureDeclaration[] | null
  /** The settled static call attribution, before alias/override argument fan-out. This is not an effect or escape proof. */
  readonly callDeclarationAt?: (call: ts.CallExpression | ts.NewExpression) => ts.SignatureDeclaration | ts.JSDocSignature | null
  /**
   * A `.call`/`.apply` reading proven sound for a call whose receiver's
   * checker type gave `unwrapExplicitThisCall` nothing to unwrap statically --
   * feeds `indexValueFlow`'s `censusExplicitThisAt` so the NEXT round's whole
   * flow index (not just this census's own target attribution) is built from
   * the corrected operand frame. `null` is the normal case: most `.call`/
   * `.apply` sites resolve statically and never reach this proof at all.
   */
  readonly explicitThisAt?: (call: ts.CallExpression) => ExplicitThisCallFrame | null
  /** The complete read-only arguments frame, per position, owned by a source signature. */
  readonly implicitArgumentsTupleAt?: (owner: ts.Node) => ImplicitArgumentsTuple | null
  /**
   * The type this node holds once unannotated parameters carry what their
   * callers pass, or `null` when nothing here improves on the checker's answer.
   *
   * `null` is the normal case and the safe one: it means "the checker's answer
   * stands", so a program with no unannotated parameters is untouched.
   */
  readonly typeAt: (node: ts.Node) => ts.Type | null
  /**
   * What an ARRAY-PATTERN element READS out of its source before its default
   * runs -- `T | undefined` off an array, the position's own type off a
   * tuple -- as against `typeAt(element)`, the type the NAME is bound to
   * once the default has resolved the absence. The destructuring producer
   * types the extraction step with this and the binding with the other; see
   * `producers/destructuring.ts`'s `extractedArrayTypeOf`.
   */
  readonly patternReadTypeAt?: (element: ts.BindingElement) => ts.Type | null
  /** A construction proof that is intentionally stronger than a usable checker answer. */
  readonly preferredTypeAt?: (node: ts.Node) => ts.Type | null
  /**
   * The narrowing a STATED parameter's annotation left room for -- see
   * `statedUpperBound` and `narrowsOnlyUnstatedPositions`. `null` everywhere
   * else, which is every node in a program whose annotations constrain every
   * position they mention.
   *
   * Separate from `typeAt` because the two are read by different authorities
   * under different guards. `typeAt` is consulted only where the checker had
   * NOTHING (`structural-layout-type.ts`'s `any`/vacuous guard), which is the
   * right rule for a parameter that stated no type and the wrong one here:
   * the checker has a perfectly good answer for `matchResult: Result<[unknown,
   * RouterRoute]>` and it is the answer that has to be overridden. Answered
   * for the declaration AND for every identifier that reads it, because a
   * parameter and its reads are one storage cell, and a cell whose slot
   * narrowed while its reads did not is the two-authority split this exists
   * to avoid (measured directly: 3 lowering blockers reading "parameter 0 is
   * bound as X but the ABI declares Y").
   */
  readonly statedTypeAt: (node: ts.Node) => ts.Type | null
  /**
   * The member list for a SYNTHESIZED disjoint-union carrier at this node, or
   * `null` wherever `typeAt` already answers or no union applies. Answers
   * what `typeAt` structurally cannot: `ts.TypeChecker.getUnionType` is not
   * public, so `derived-expression-type.ts`'s `disjointUnionMembersOf` hands
   * back the member list for `structural.ts` to `table.intern` directly.
   */
  readonly unionArmsAt: (node: ts.Node) => readonly ts.Type[] | null
  /**
   * The argument EXPRESSIONS whose types `typeAt`/`unionArmsAt` folded for a
   * parameter. The census speaks in checker types, and a checker type is not
   * always the whole answer: `Date.prototype` types as a Date instance while
   * the structural layer carries it as the prototype object itself
   * (`prototypeObjectTypeAt`). Exposing the nodes lets that layer re-ask its
   * own question of what was passed instead of trusting the checker's image.
   */
  readonly argumentsAt?: (parameter: ts.ParameterDeclaration) => readonly ts.Expression[] | null
  /**
   * The array ELEMENT an UNANNOTATED rest parameter is called with, joined
   * across every reachable call site's variable-width TAIL -- `null` when
   * there is no such join (no call sites, an unresolved or spread argument
   * anywhere in the tail, or a genuine disagreement `joinOfWrites` cannot
   * settle). `structural-parts.ts`'s `parameterOf` (the ABI's rest slot) and
   * `structural.ts`'s `rest-parameter-array-element` rule (every body-side
   * reference to the same parameter) both read this, so the signature and
   * the body it wraps publish the identical element and can never disagree
   * about it -- see `parameter-slot.ts`'s `restParameterArrayTypeOf` header
   * for why that agreement is the whole point.
   *
   * Deliberately its own field rather than a `typeAt`/`unionArmsAt` answer:
   * both of those publish the WHOLE value a node holds, unwrapped, and a
   * rest parameter's element is not that -- it still needs wrapping in the
   * `array` shape the language always constructs it as, exactly as
   * `restParameterArrayTypeOf`'s own already-widened element does.
   */
  readonly restElementTypeAt?: (parameter: ts.ParameterDeclaration) => ts.Type | null
  /** How many parameters this census bound, for measurement. */
  readonly boundCount: number
  /**
   * Why each parameter this census could not bind was refused, one entry per
   * refused parameter, carrying that parameter as `owner`.
   *
   * A refusal here is not a defect -- every one of them leaves the checker's
   * answer standing, which is the behaviour before this module existed. It
   * used to be a `ReadonlyMap<string, number>`, a count per prose reason with
   * no owner: a count says a cell went untyped but not WHICH cell, so nothing
   * downstream could act on one. `censusRefusalCounts` derives the old shape
   * for a caller that only ever wanted the tally.
   */
  readonly refusals: readonly CensusRefusal[]
  /** Why this particular parameter was not bound, for attributing one declaration rather than a total. */
  readonly refusalOf: (parameter: ts.ParameterDeclaration) => string | null
  /** Every refused parameter with its reason, one per line -- `GEA_BINDING_DEBUG` only. */
  readonly debugReport?: () => string
}

/** A census that binds nothing, for callers that state no program. */
export const emptyParameterBindingCensus: ParameterBindingCensus = {
  typeAt: () => null,
  statedTypeAt: () => null,
  unionArmsAt: () => null,
  boundCount: 0,
  refusals: [],
  refusalOf: () => null
}

const isAnyType = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Any) !== 0

/** A stable empty set, so alias attribution can return "nothing" without allocating one each time. */
const EMPTY_DECLARATIONS: ReadonlySet<ts.SignatureDeclaration> = new Set()

/**
 * Whether a type is bare `Function` -- a type with NO calling convention at
 * all. TypeScript's checker lets any callable be assigned to `Function` as an
 * error-tolerance rule, but the type itself declares zero call signatures and
 * zero construct signatures, so it says nothing about arity or return either.
 * Signature count is the real question and is checked first; the symbol name
 * is a second, narrower gate so a user type that happens to declare no
 * signatures of its own (an empty interface, `Record<string, never>`) is not
 * swept in beside it -- only the library's own `Function` is.
 */
const isBareFunctionType = (type: ts.Type): boolean => {
  if (type.getCallSignatures().length > 0) return false
  if (type.getConstructSignatures().length > 0) return false
  return type.getSymbol()?.getName() === 'Function'
}

/**
 * Whether a type says nothing about STORAGE, and so is not evidence.
 *
 * Four of the checker's answers are not carriers, and a census that admits
 * them binds a parameter to a fact about something other than the value it
 * holds:
 *
 * - `any` is the absence this module exists to fill, and propagating it is what
 *   it exists to stop.
 * - `void` is a statement about a RESULT nobody may read. It and `undefined`
 *   are one runtime value and two facts, so a call passing the result of a void
 *   function binds `void` into a cell whose ABI correctly says `undefined` --
 *   measured, as an ABI disagreement in `PolyhedronGeometry`.
 * - `never` is REACHABILITY, not storage. `const v = [];` before any write is
 *   `never[]`, so `v[ i ][ k + 1 ]` reads `never` -- and `pushVertex( v[ i ][ k
 *   + 1 ] )` is a call that plainly does happen. Binding its parameter to
 *   "no value ever arrives" describes the empty literal, not the argument.
 * - bare `Function` is `isUnannotated`'s own exception admitted as a
 *   CANDIDATE, and it must stay non-evidence everywhere else in this module
 *   for the same reason: `Object3D.traverse( callback ) { callback( this );
 *   children[i].traverse( callback ); }` passes `callback` to a recursive
 *   call of `traverse` itself, and if the declared `Function` type were
 *   usable evidence, `known()` would read it straight off the checker at that
 *   self-reference (before this round's own binding exists) and hand it to
 *   `agreedArgumentType` as one of the call sites' passed types. Bare
 *   `Function` is assignable-to by nearly every real function type, so
 *   `widestOf` would then pick it as the "widest" answer over every genuine
 *   callback type the OTHER call sites pass -- collapsing a real function
 *   value back down to the one type that carries no calling convention,
 *   silently. Measured: admitting it produced exactly that, surfacing as a
 *   `native-record-ref` binding a `function-value-dispatch` ABI disagreed
 *   with. Excluding it here instead means a self-reference like this one is
 *   refused (`argument-states-no-storage`) rather than answered wrong, and
 *   the parameter binds only once every OTHER call site's real evidence
 *   agrees.
 *
 * Refused rather than rewritten: every type this module produces comes out of
 * the checker, and substituting `undefined` for a `void` here would be the
 * compiler stating a type instead of reading one. A parameter whose only
 * evidence is one of these keeps the checker's own answer, which is the
 * behaviour before this module existed.
 */
const isUnusableEvidence = (type: ts.Type): boolean => statesNoStorage(type) || isBareFunctionType(type) || isGenericCallableType(type)

/**
 * Whether a type is a GENERIC callable -- `typeof emit` for `function emit<T
 * extends Node>(node: T)`, passed uninstantiated to a parameter typed by a
 * generic function type (`emitNodeList(emit, ...)` over `EmitFunction`).
 *
 * Not evidence for the same reason `Function` is not: the spelling says which
 * function, not which frame. The frame the cell holds is the copy the
 * specialization census mints for that very reference (`fromValueUse`), over
 * the instantiation the PARAMETER's own type has in this program -- and the
 * declared parameter type resolves to exactly that, while this argument type
 * resolved in the callee's copy would read the function's own `T` with
 * nothing binding it. Measured: `emitFn(child)` refused
 * `function-value-dispatch((record(Node)) -> void) ->
 * function-value-dispatch((native-record-ref(Stmt)) -> void)`, the cell
 * typed from the argument and the read from the declaration.
 */
const isGenericCallableType = (type: ts.Type): boolean =>
  [...type.getCallSignatures(), ...type.getConstructSignatures()].some((signature) => (signature.getTypeParameters()?.length ?? 0) > 0)

/**
 * Whether this parameter is one the program never typed -- for the one
 * question this census answers: what can a callable value here be called
 * with.
 *
 * A type annotation, a JSDoc `@param`/`@type` tag, and a default initializer
 * are all the program stating the type; only the total absence of all three
 * (or a bare `Function` annotation, immediately below) leaves the checker
 * with nothing to read. The `any` test comes last and is what makes this
 * honest for a parameter TypeScript typed contextually -- a callback's
 * parameter in `arr.map(x => x)` has no annotation and is not `any`, and
 * rebinding it from a call site would overwrite a real inference.
 *
 * Bare `Function` -- `@param {Function} callback`, or `: Function` -- is the
 * one exception to "an annotation settles it". Calling a `Function`-typed
 * value is permitted only by the checker's own error tolerance; the type
 * declares no call signature and no construct signature, so for THIS
 * question -- what does a call here actually pass -- it is exactly as
 * uninformative as no annotation at all. `Object3D.traverse`'s `callback`
 * parameter is declared this way and the body calls `callback( this )`: one
 * argument, where the annotation states none. A type that DOES declare a call
 * signature -- `(x: T) => U`, a JSDoc `@callback` typedef -- is real evidence
 * and keeps stopping the census exactly as before; only the signature-free
 * case is let through.
 *
 * A real annotation that RESOLVES TO A NON-STATEMENT -- `options: {}`, `x:
 * object`, `v: Object` -- is the second exception, and it is the JSDoc rule
 * three lines of this function already apply, asked of the other spelling.
 * `jsDocTypeStatesNothing` stopped a vague `@param {Object}` tag from
 * outranking the census; a parameter written `: object` in TypeScript states
 * exactly as little, and there is no reason the census should defer to one
 * spelling of "nothing" and not the other. See `annotationStatesNothing`
 * (`derived-expression-type.js`) for what is deliberately NOT in it --
 * `unknown`, a named empty type, an explicit `: any`.
 */
const isUnannotated = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): boolean => {
  if (parameter.dotDotDotToken) return false
  if (!ts.isIdentifier(parameter.name)) {
    // A DESTRUCTURING PATTERN as the parameter's name -- `function f([x, y])`,
    // `function g({ a, b })` -- with no annotation. TypeScript synthesizes the
    // parameter's type from the pattern's own SHAPE (`[any, any]`, `{ a: any;
    // b: any }`): a statement about the syntax of the binding, not about any
    // value a caller passes, and the `[any, any]` tuple is actively wrong for
    // the language, which binds the pattern off ANY iterable of any length
    // (`f([])` is legal and binds both names to `undefined`). So the site
    // type is no evidence at all, exactly as a bare `any` parameter's is, and
    // the census binds the slot from the call sites; the pattern's leaves then
    // read out of THAT bound value (`resolve`'s `BindingElement` branch).
    // A JSDoc tag or a real annotation on the pattern is a statement and
    // keeps the parameter out, as it does for a named one.
    return impliedPatternParameterOf(checker, parameter) !== null
  }
  if (parameter.type) {
    // Read at the TYPE NODE, never at the parameter. `checker.getTypeAtLocation`
    // on an OPTIONAL parameter answers for the site -- `object | undefined`,
    // `{} | undefined` -- and the trailing `isAnyType` test at the bottom of
    // this function is written for a site type that really is bare `any`. That
    // exact confusion is what silently re-excluded the empty-object JSDoc tags
    // this rule's own sibling had just admitted (see the comment below), so
    // this branch asks the annotation itself and RETURNS immediately either
    // way rather than falling through to a test that answers a different
    // question.
    return annotationStatesNothing(checker, parameter.type, checker.getTypeFromTypeNode(parameter.type))
  }
  const jsDocParamTags = ts.getJSDocParameterTags(parameter)
  const jsDocType = ts.getJSDocType(parameter) ?? jsDocParamTags[0]?.typeExpression?.type
  if (jsDocType || jsDocParamTags.length > 0) {
    // HELD, not landed: candidacy itself is sound (see the doc above), but
    // admitting it before `.call`/`.apply` attribution exists (see
    // `unwrapExplicitThisCall`) measurably regressed `EventDispatcher.
    // addEventListener`'s `listener` -- `callsByDeclaration` only ever saw
    // the 2 direct-call sites in the whole corpus, both coincidentally
    // zero-arg, so the join correctly found no disagreement among evidence
    // that was itself an incomplete sample and bound `() => void`, while
    // `dispatchEvent` really calls every listener with one argument via
    // `array[i].call( this, event )`. Re-enable
    // (`isBareFunctionType(checker.getTypeAtLocation(parameter))`) once that
    // attribution gap is closed and re-measured.
    //
    // NARROWED, not repealed: the exclusion above still stands whenever the
    // JSDoc type resolves to something the checker can actually read -- that
    // is real evidence, exactly as informative as a TS annotation, and stays
    // out of this census for the same reason a typed parameter always has.
    // It is lifted for unusable JSDoc evidence or the same broad object bound
    // `annotationStatesNothing` admits for a TypeScript parameter. This also
    // covers the real lib Object interface, whose inherited methods state no
    // configuration fields. Parameter refinement does not discard that tag on
    // return cells. At that point the program has stated nothing this
    // compiler can read, so refusing the parameter is refusing it for a fact
    // that isn't there. Measured on the three.js corpus: 31/38 obligations (82%)
    // and 20/24 distinct parameters (83%) in this bucket resolve to nothing
    // and are exactly the unimported cross-module-name pattern documented on
    // `jsDocTypeIsUninformative`; the remaining 17-18% resolve to a real type
    // (`number | Vector3`, ...) and keep being excluded here, same as before
    // this change.
    if (
      !jsDocType ||
      !(jsDocTypeStatesNothing(checker, jsDocType) || annotationStatesNothing(checker, jsDocType, checker.getTypeFromTypeNode(jsDocType)))
    )
      return false
    // Admit it HERE, rather than falling through to the `isAnyType(checker.
    // getTypeAtLocation(parameter))` test below -- that test is written for
    // the OTHER path into this function, the parameter with no annotation of
    // any kind, where the checker's site type really is bare `any`. A tagged
    // parameter's site type is not: it is the checker's answer for the TAG,
    // and a `[name]`-bracketed (optional) tag makes that a real UNION with
    // `undefined` for any resolved type except `any` itself -- TypeScript's
    // own union normalization absorbs `any | undefined` back down to `any`,
    // which is the ONLY reason the `any`/`unknown` half of `jsDocTypeStates
    // Nothing` ever reached this point undetected before. `{} | undefined`
    // does not absorb the same way, so an empty-object tag marked optional
    // -- `InterleavedBuffer.clone( [data] )` via `@types/three`'s own `data:
    // {}` -- hit the `isAnyType` test below, found a `Union`, and was
    // silently re-excluded even though the line above had already judged the
    // tag to state nothing. Measured: this was the entire reason widening
    // `jsDocTypeStatesNothing` alone moved zero boxes on the three.js app.
    return true
  }
  // A DEFAULT VALUE is not a type. `constructor( parameters = {} )` states what
  // the parameter holds when a caller omits it, and TypeScript widens that into
  // `{}` -- a type with no members, which every real call site contradicts.
  // `WebGLRenderer`'s whole configuration arrives through this parameter, so
  // `{}` is the wall the entire renderer's typing stands behind.
  //
  // Binding it is sound only when the default is UNREACHABLE, and that is a
  // condition this census already tests for its own reasons: every call site
  // must pass an argument at this position (`call-passes-no-argument`) and the
  // function must not escape to a caller it cannot see. A default that can
  // still run is a second value the agreed type does not describe.
  if (parameter.initializer) return true
  return isAnyType(checker.getTypeAtLocation(parameter))
}

/**
 * Whether a type still carries a piece of an UNSUBSTITUTED generic -- a bare
 * type parameter, an indexed access whose object type is one (`E['Bindings']`),
 * a conditional or a substitution.
 *
 * Such a type is not a carrier and never becomes one: the representation
 * deriver has nothing to resolve `E['Bindings']` against and publishes
 * `unresolved(...)`, which fails preflight as an unmet obligation rather than
 * as a refusal anyone can read. hono's `Hono` is generic in `E` and every
 * copy of it shares one parameter node, so a census answer taken from a call
 * site INSIDE the generic carries `E` out with it -- 10 unmet obligations
 * reading "an indexed access whose object type is still a type parameter has
 * no member set to resolve", measured the first time this admission ran
 * without the guard.
 */
export const carriesUnsubstitutedGeneric = (checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean => {
  if (depth > 8) return false
  const open = ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution
  if ((type.flags & open) !== 0) return true
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some((part) => carriesUnsubstitutedGeneric(checker, part, depth + 1))
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  const reference = type as ts.TypeReference
  if (reference.target === undefined) return false
  return checker.getTypeArguments(reference).some((part) => carriesUnsubstitutedGeneric(checker, part, depth + 1))
}

/**
 * A parameter the program DID type, whose statement is still only an UPPER
 * BOUND -- one with an `any`/`unknown`/bare-`Function` position somewhere
 * inside it. Returns that stated type, for `narrowsOnlyUnstatedPositions` to
 * test the agreed argument type against; `null` for every parameter whose
 * annotation constrains every position it mentions, which is nearly all of
 * them and which this census must not touch.
 *
 * hono's `HonoRequest( ..., matchResult: Result<[unknown, RouterRoute]> )` and
 * `compose( middleware: [[Function, unknown], unknown][] | [[Function]][] )`
 * are the two measured cases: both state a full structure and leave exactly
 * the handler slot unstated, and both are handed a fully concrete value by the
 * program's only caller. See `narrowsOnlyUnstatedPositions` for why reading
 * such an annotation as the last word forces an unrenderable aggregate rebuild.
 *
 * The same three structural exclusions `isUnannotated` applies hold here --
 * a rest parameter, a destructured one, and a type that is itself no evidence.
 */
const statedUpperBound = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if (parameter.dotDotDotToken) return null
  if (!ts.isIdentifier(parameter.name)) return null
  if (!parameter.type) return null
  const declared = checker.getTypeFromTypeNode(parameter.type)
  // Already `isUnannotated`'s own business, and admitted there.
  if (annotationStatesNothing(checker, parameter.type, declared)) return null
  if (isUnusableEvidence(declared)) return null
  if (!containsUnstatedPosition(checker, parameter.type, declared)) return null
  // A DEFAULTED or OPTIONAL parameter's statement is `T | undefined` to its
  // callers, whatever its annotation spells: the absence is what the default
  // exists to answer. Testing the agreed argument type against the bare `T`
  // refuses every such parameter whose caller passes a possibly-absent value
  // -- hono's `new HonoRequest( ..., this.#matchResult )` passing a `Result<
  // [H, RouterRoute]> | undefined` into `matchResult: Result<[unknown,
  // RouterRoute]> = [[]]` is the measured case, and it is ordinary
  // TypeScript. `contributeDefaultedParameter` (`producers/bindings.ts`)
  // already splits this answer back into the raw slot (with the absence) and
  // the body's own binding (without it), so handing it the union is what
  // makes both halves agree.
  const absent = parameter.initializer !== undefined || parameter.questionToken !== undefined
  return absent ? checker.getNullableType(declared, ts.TypeFlags.Undefined) : declared
}

/**
 * A pure open object dictionary whose values the program explicitly leaves
 * dynamic.
 *
 * BSON's `Document` is exactly `{ [key: string]: any }`. TypeScript permits a
 * value with that annotation to be flow-narrowed to Array, Map or a named
 * record by `Array.isArray`, `instanceof` and user predicates. Those narrowed
 * values do not become dictionaries at runtime; the annotation is an upper
 * bound on property reads, while the flow facts still state their physical
 * identities. This predicate is deliberately limited to a memberless string
 * index with an explicit `any` value so an ordinary typed record is never
 * widened by the mechanism below.
 */
const openDynamicObjectUpperBound = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | null => {
  if (!parameter.type || !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return null
  const declared = checker.getTypeFromTypeNode(parameter.type)
  if (checker.getPropertiesOfType(declared).length !== 0) return null
  const dynamicStringIndex = checker
    .getIndexInfosOfType(declared)
    .find((index) => (index.keyType.flags & ts.TypeFlags.String) !== 0 && (index.type.flags & ts.TypeFlags.Any) !== 0)
  return dynamicStringIndex ? declared : null
}

/**
 * A flow narrowing that changes the value's physical container identity.
 *
 * An open `[string]: any` annotation admits both exotic containers and named
 * structural records. Only the former need a distinct storage arm: Array and
 * the keyed collections have layouts a dictionary cannot impersonate. A user
 * predicate narrowing the same value to a record interface merely gives typed
 * names to dictionary properties; treating that view as a second allocation
 * kind loses negative narrowing when control leaves the predicate branch.
 */
const isFlowContainerType = (checker: ts.TypeChecker, anchor: ts.Node, type: ts.Type): boolean =>
  checker.isArrayType(type) || ['Map', 'Set', 'WeakMap', 'WeakSet'].some((name) => isStandardInterfaceType(checker, anchor, name, type))

/**
 * An UNANNOTATED rest parameter this census considers for its own,
 * element-wise join -- see `restElementTypeAt`. Kept separate from
 * `ParameterCandidate`: a rest parameter's physical slot is never one
 * argument's type (what the ordinary sweep below binds), it is the ARRAY
 * the language always constructs, and its element is a join over every
 * call's variable-width TAIL rather than one fixed ordinal.
 */
interface RestParameterCandidate {
  readonly declaration: ts.SignatureDeclaration
  readonly parameter: ts.ParameterDeclaration
  /** The rest parameter's own ordinal -- where its variable-width tail starts at every call site. */
  readonly index: number
}

/** One parameter this census is considering, and the annotation it may only narrow WITHIN -- see `statedUpperBound`. */
interface ParameterCandidate {
  readonly declaration: ts.SignatureDeclaration
  readonly parameter: ts.ParameterDeclaration
  readonly index: number
  /** `null` for an unannotated parameter. */
  readonly stated: ts.Type | null
  /** The open dynamic object boundary whose flow-narrowed physical arms must remain distinct. */
  readonly flowCarrierUpperBound: ts.Type | null
}

/**
 * The program-wide evidence `censusParameterBindings` reads and never rewrites.
 *
 * Every entry here is a fact about the program's syntax and the checker's own
 * answers, so it is the same in every round: which symbol each identifier
 * resolves to, which declaration the checker attributes each call to, which
 * symbols are assigned and with what, which parameters are candidates at all.
 * None of it can improve as bindings accumulate -- that is what the fixpoint
 * inside the census is for, and what `callsByDeclaration` (rewritten every
 * round by `attributeCalls`) is deliberately NOT part of.
 *
 * It is hoisted out because the census does not run once. `frontend.ts`
 * composes it against its own settled output until `boundCount` stops moving,
 * which is 5 rounds on the three.js app, and each round used to rebuild all
 * of this from scratch: a `getSymbolAtLocation` for every identifier in the
 * program, a `getResolvedSignature` for every call, `isUnannotated` and
 * `statedUpperBound` for every parameter, and the whole alias index. Built
 * once and passed in, the checker answers each of those questions a fifth as
 * often.
 *
 * Passed as an argument rather than memoized in module state, for the reason
 * `CLAUDE.md` gives: this module is functions plus factory-created state, and
 * a cache living in the module would be shared across programs -- every entry
 * here is keyed by nodes and symbols belonging to ONE checker.
 */
/**
 * One write an assignment makes into a parameter's own cell.
 *
 * `operatorTyped` marks the writes whose type the OPERATOR fixes rather than
 * the operands: `r *= a` yields a number whatever `r` and `a` held, `s += 'a'`
 * a string, `n++` a number. For those the flow layer deliberately records no
 * value expression (`ValueWrite.value` is `null`, because there is no
 * sub-expression holding the written value), and the honest evidence is the
 * type of the whole assignment expression -- which is `site`.
 */
export interface AssignedWrite {
  readonly expression: ts.Expression
  readonly operatorTyped: boolean
}

export interface ParameterBindingProgramIndex {
  readonly implicitArgumentsUses: ReadonlyMap<ts.SignatureDeclaration, readonly ts.Identifier[]>
  readonly valueFlow: ValueFlowIndex
  readonly candidates: readonly ParameterCandidate[]
  /** Every UNANNOTATED rest parameter this census may join an element type for -- see `restElementTypeAt`. */
  readonly restParameterCandidates: readonly RestParameterCandidate[]
  /** `candidates` minus the ones a reassignment already refuses. */
  readonly notReassigned: readonly ParameterCandidate[]
  /** The candidates a reassignment refuses, kept (not just counted) so the refusal can name which parameter. */
  readonly reassigned: readonly ParameterCandidate[]
  /** Stated JS parameters outside inference that a caller may still leave out -- see `omitted-stated-parameter.ts`. */
  readonly omissionSites: readonly {
    readonly declaration: ts.SignatureDeclaration
    readonly parameter: ts.ParameterDeclaration
    readonly index: number
    readonly stated: ts.Type
  }[]
  readonly assigned: ReadonlySet<ts.Symbol>
  /**
   * What each in-body assignment writes into a reassigned parameter's own
   * cell, keyed by the parameter's symbol -- `null` once any such write states
   * only that a write HAPPENED, since a join cannot be taken over evidence
   * that was never produced.
   */
  readonly assignedEvidence: ReadonlyMap<ts.Symbol, readonly AssignedWrite[] | null>
  readonly allCalls: readonly (ts.CallExpression | ts.NewExpression)[]
  readonly checkerAttribution: ReadonlyMap<ts.CallExpression | ts.NewExpression, ts.Declaration | null>
  readonly invocationOperands: ReadonlyMap<ts.CallExpression | ts.NewExpression, FlowInvocationOperands>
  readonly aliasEvidence: AliasEvidence
  /** Which methods override each base method, so a virtual call's evidence reaches every override. */
  readonly overridesOfBaseMethod: ReadonlyMap<ts.Declaration, readonly ts.MethodDeclaration[]>
  /**
   * Every OTHER body that publishes the same member symbol as a given
   * callable: a class's own declared method alongside every `receiver.<name>
   * = function ( ... ) { ... }` instance override of the identical key, keyed
   * by symbol identity (never by name spelling alone).
   */
  readonly siblingMemberDeclarations: ReadonlyMap<ts.Declaration, readonly ts.SignatureDeclaration[]>
}

export const indexParameterBindingProgram = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  valueFlow: ValueFlowIndex = indexValueFlow(checker, files, reachable),
  argumentsObjects: ArgumentsObjectCensus = censusArgumentsObjects(checker, files)
): ParameterBindingProgramIndex => {
  // `GEA_INDEX_TIMING=1` prints what one build of this index costs. It is the
  // only honest way to price the hoist on a shared machine: across two runs
  // the load swings by a factor of two and `dist/` is rebuilt underneath
  // them, but WITHIN one run the count of builds is the whole difference --
  // five without the hoist, one with it.
  const startedAt = process.env['GEA_INDEX_TIMING'] ? performance.now() : 0
  const candidates: ParameterCandidate[] = []
  const restParameterCandidates: RestParameterCandidate[] = []
  const omissionSites: { declaration: ts.SignatureDeclaration; parameter: ts.ParameterDeclaration; index: number; stated: ts.Type }[] = []
  const assigned = new Set<ts.Symbol>()
  // An update, logical assignment, destructuring assignment, or loop binding
  // also replaces a parameter. Sharing the write inventory prevents the
  // argument census from retaining an argument-only carrier after such a write.
  const assignedEvidence = new Map<ts.Symbol, AssignedWrite[] | null>()
  for (const write of valueFlow.allWrites) {
    if (write.slot !== 'whole' || !write.target.symbol) continue
    const declaration = write.target.declaration
    if (
      declaration &&
      ts.isParameter(declaration) &&
      write.edge !== 'call-argument' &&
      write.edge !== 'super-argument' &&
      write.edge !== 'default-parameter'
    ) {
      assigned.add(write.target.symbol)
      // A compound assignment or update names no sub-expression holding the
      // written value, so the flow layer records none. The checker can state
      // its result at the whole expression; operand-sensitive cases may need
      // the complete incoming frame before that result can be recovered. Every other write hands over its value expression, and
      // a write that hands over neither leaves this parameter with a gap no
      // join can close.
      const evidence: AssignedWrite | null =
        write.edge === 'compound-assignment' &&
        (ts.isBinaryExpression(write.site) || ts.isPostfixUnaryExpression(write.site) || ts.isPrefixUnaryExpression(write.site))
          ? { expression: write.site, operatorTyped: true }
          : write.value !== null
            ? { expression: write.value, operatorTyped: false }
            : null
      const seen = assignedEvidence.get(write.target.symbol)
      if (seen === null) continue
      if (evidence === null) assignedEvidence.set(write.target.symbol, null)
      else if (seen) seen.push(evidence)
      else assignedEvidence.set(write.target.symbol, [evidence])
    }
  }
  const allCalls = valueFlow.calls.map((site) => site.call)
  const checkerAttribution = new Map(valueFlow.calls.map((site) => [site.call, site.checkerDeclaration]))
  const invocationOperands = new Map(valueFlow.calls.map((site) => [site.call, site.operands]))

  for (const file of files) {
    // The same boundary `flow/value-flow.ts` has always walked, and the fourth
    // census to need it (`local-bindings.ts` and `collection-bindings.ts` were
    // the other two corrected). `forEachReachableStatement` filters TOP-LEVEL
    // statements only; a method inside a reachable class that whole-program DCE
    // has pruned is still descended into by the bare `ts.forEachChild` below.
    // Its parameters were therefore gathered as candidates, `agreedArgumentType`
    // asked `calls` a question about a body that never runs, and the correct
    // answer -- no call sites, no counted references -- was published as a
    // refusal. The three.js app's `Quaternion.setFromUnitVectors`,
    // `Vector3.project`/`unproject` and the whole pruned `BufferGeometry`
    // helper set are refusals of exactly this kind: evidence that was never
    // going to exist for code that is never emitted.
    const visit = (node: ts.Node): void => {
      if (reachable.memberIsPruned(node)) return
      if (isTrackedCallable(node)) {
        runtimeParametersOf(node).forEach((parameter, index) => {
          // An UNANNOTATED rest parameter is a candidate for its OWN
          // element-wise join (`restElementTypeAt`), never for the ordinary
          // fixed-position sweep below -- `isUnannotated` returns `false` for
          // every rest parameter precisely because a rest parameter's slot is
          // not one argument's type. A real annotation (`...args: string[]`,
          // even the widening `...args: any`) is the program stating a real
          // element already, and is left to the checker exactly as before.
          if (parameter.dotDotDotToken !== undefined && parameter.type === undefined) {
            restParameterCandidates.push({ declaration: node, parameter, index })
          }
          if (isUnannotated(checker, parameter))
            candidates.push({ declaration: node, parameter, index, stated: null, flowCarrierUpperBound: null })
          else {
            const stated = statedUpperBound(checker, parameter)
            const flowCarrierUpperBound = openDynamicObjectUpperBound(checker, parameter)
            if (stated || flowCarrierUpperBound)
              candidates.push({
                declaration: node,
                parameter,
                index,
                stated: stated ?? flowCarrierUpperBound,
                flowCarrierUpperBound
              })
            else {
              // Not inferred -- but a caller may still leave it out.
              const omissionStated = omissionStatedTypeOf(checker, parameter)
              if (omissionStated) omissionSites.push({ declaration: node, parameter, index, stated: omissionStated })
            }
          }
        })
      }
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }

  /**
   * VALUE-FLOW evidence for the two alias shapes `isBindingOnlyReference`
   * treats as non-escapes: which functions are published under a member
   * symbol, and which are bare-returned from a selector. Built once --
   * see `AliasEvidence`'s own doc for why this does not need the round loop.
   */
  const aliasEvidence: AliasEvidence = indexAliasEvidence(checker, files, reachable, indexNamedCallables(checker, files, reachable))
  // A reassignment makes a parameter's value differ from the argument's -- but
  // not, on its own, its TYPE. `function f(r, a) { r *= a; }` called as
  // `f(1, 2)` holds a number on entry and a number after the write, and
  // refusing it outright bound neither: three's
  // `setClear( r, g, b, a, premultipliedAlpha )` lost all five parameters
  // because three of them are scaled in the body. An assignment is a WRITE to
  // the parameter's cell, exactly as a `let`'s later assignment is a write to
  // its cell, and `writeSetTypeOf` already answers that shape by joining every
  // write. So the assigned values join the call-site arguments and face the
  // same agreement test -- `x = 'text'` against `f(1)` still refuses, as a
  // disagreement rather than as a category.
  //
  // What survives as a category is a reassignment whose written value this
  // layer never produced (a destructuring or iteration binding it does not
  // open). There the cell holds something unstated, and no join can close it.
  // That test is a fact about the program, asked here once rather than once
  // per round, and the refusal keeps naming the parameter.
  const notReassigned: ParameterCandidate[] = []
  const reassigned: ParameterCandidate[] = []
  for (const candidate of candidates) {
    const symbol = checker.getSymbolAtLocation(candidate.parameter.name)
    if (symbol && assigned.has(symbol) && assignedEvidence.get(symbol) == null) reassigned.push(candidate)
    else notReassigned.push(candidate)
  }

  /**
   * Every method declaration that OVERRIDES a given base-class method, keyed
   * by the base's own declaration.
   *
   * A call is written against the declaration the checker resolves it to,
   * which for `this.interpolate_( i1, t0, t, t1 )` inside `Interpolant` is
   * `Interpolant`'s own declaration -- never `LinearInterpolant`'s override,
   * even though that override is what actually runs. The override therefore
   * looks callerless (`no-call-site`) and its parameters stay `any`, which is
   * how three's whole interpolant, loader and curve hierarchy stays dynamic:
   * `interpolate_`, `load`, `getTangentAt` are each defined once with real
   * callers on the base and re-declared with none on every subclass.
   *
   * Inheriting the base's calls is sound because it states LESS than the
   * program does, not more: a virtual call may dispatch into ANY override, so
   * every override's parameter storage must already accept what that call
   * passes. Evidence is only ever ADDED -- the override's own direct calls are
   * still collected, both sets feed the same `widestOf` join, and a genuine
   * disagreement between them refuses with `call-sites-disagree` rather than
   * picking a side. An override with more parameters than the base is passed
   * fewer arguments than it declares, which `call-passes-no-argument` already
   * refuses; that is a refusal replacing a refusal, never a binding.
   *
   * Built once, outside the fixpoint: class inheritance is a fact about the
   * program's syntax, so unlike call attribution it cannot improve as
   * bindings accumulate.
   */
  const overridesOfBaseMethod = ((): ReadonlyMap<ts.Declaration, readonly ts.MethodDeclaration[]> => {
    const overrides = new Map<ts.Declaration, ts.MethodDeclaration[]>()
    const record = (base: ts.Declaration, override: ts.MethodDeclaration): void => {
      const existing = overrides.get(base)
      if (existing) existing.push(override)
      else overrides.set(base, [override])
    }
    const link = (method: ts.MethodDeclaration): void => {
      const owner = method.parent
      if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return
      if (!ts.isIdentifier(method.name)) return
      const name = method.name.text
      const seen = new Set<ts.Type>()
      // `getBaseTypes` READS `resolvedBaseTypes` and is defined only for a
      // class-or-interface type. Handing it any other object type -- or the
      // STATIC side of a class, which `getTypeAtLocation(classDeclaration)`
      // returns -- throws rather than answering, so both are tested here.
      const classOrInterface = (type: ts.Type | undefined): type is ts.InterfaceType =>
        type !== undefined &&
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0
      const climb = (type: ts.InterfaceType, depth: number): void => {
        if (depth > 8) return
        for (const base of checker.getBaseTypes(type) ?? []) {
          if (!base || seen.has(base)) continue
          seen.add(base)
          for (const declaration of checker.getPropertyOfType(base, name)?.declarations ?? []) {
            if (ts.isMethodDeclaration(declaration) && declaration !== method) record(declaration, method)
          }
          if (classOrInterface(base)) climb(base, depth + 1)
        }
      }
      const ownSymbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
      const ownType = ownSymbol ? checker.getDeclaredTypeOfSymbol(ownSymbol) : undefined
      if (classOrInterface(ownType)) climb(ownType, 0)
    }
    const walk = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) link(node)
      ts.forEachChild(node, walk)
    }
    for (const file of files) forEachReachableStatement(reachable, file, walk)
    return overrides
  })()

  /**
   * `overridesOfBaseMethod` links a SUBCLASS method to the base it overrides
   * through `extends`. This links the OTHER way one symbol gets more than one
   * body: a class's own declared shape of a key alongside a `receiver.<name>
   * = function ( ... ) { ... }` write that overrides it on ONE instance,
   * never through inheritance. Three's `mesh.onBeforeRender = function (
   * renderer, object ) { ... }` next to `Object3D`'s declared (empty)
   * `onBeforeRender(){}` is exactly this: `object.onBeforeRender( this,
   * object )` resolves, through the checker, to the STATED stub -- TypeScript
   * has no flow model of "this one instance was later given its own property"
   * -- so every call through an `Object3D`-typed receiver is attributed there
   * and never to the override that actually runs and reads its parameters.
   * `nameOfCallable` already draws the member name out of both shapes;
   * grouping by the SYMBOL the checker resolves that name to (never by
   * spelling) is what keeps this sound against an unrelated look-alike: an
   * object literal's own `onBeforeRender(){}` gets its OWN anonymous-type
   * property symbol, never `Object3D`'s, so it is never grouped with the
   * class's declaration and never receives its calls.
   *
   * No separate "is this slot closed" gate is needed here: attributing a call
   * between siblings only ever ADDS evidence, exactly as `overridesOfBaseMethod`
   * argues above, and `escapeReason`'s own member-closure obligation --
   * asked of the SAME symbol, over EVERY write to it -- already refuses
   * whenever some other write into the slot cannot be named. This can only
   * widen a join or trigger that existing refusal; it cannot narrow one.
   */
  const siblingMemberDeclarations = ((): ReadonlyMap<ts.Declaration, readonly ts.SignatureDeclaration[]> => {
    const bySymbol = new Map<ts.Symbol, ts.SignatureDeclaration[]>()
    const record = (declaration: ts.SignatureDeclaration): void => {
      const name = nameOfCallable(declaration)
      const symbol = name && checker.getSymbolAtLocation(name)
      if (!symbol) return
      const existing = bySymbol.get(symbol)
      if (existing) existing.push(declaration)
      else bySymbol.set(symbol, [declaration])
    }
    const walk = (node: ts.Node): void => {
      if (
        (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) &&
        'body' in node &&
        node.body !== undefined
      )
        record(node)
      ts.forEachChild(node, walk)
    }
    for (const file of files) forEachReachableStatement(reachable, file, walk)
    const result = new Map<ts.Declaration, ts.SignatureDeclaration[]>()
    for (const declarations of bySymbol.values()) {
      if (declarations.length < 2) continue
      for (const declaration of declarations)
        result.set(
          declaration,
          declarations.filter((other) => other !== declaration)
        )
    }
    return result
  })()

  if (process.env['GEA_INDEX_TIMING']) {
    process.stderr.write(`[INDEX] parameter-binding program index built in ${(performance.now() - startedAt).toFixed(0)}ms\n`)
  }

  return Object.freeze({
    implicitArgumentsUses: argumentsObjects.usesByOwner,
    valueFlow,
    candidates,
    restParameterCandidates,
    notReassigned,
    reassigned,
    omissionSites,
    assigned,
    assignedEvidence,
    allCalls,
    checkerAttribution,
    invocationOperands,
    aliasEvidence,
    overridesOfBaseMethod,
    siblingMemberDeclarations
  })
}

/**
 * The declared tuple element a call's LAST argument, a spread of a closed-tuple
 * rest parameter, supplies at argument position `index`, or `null` when the
 * call has no such spread or `index` lies before it or past its arity. Only a
 * final spread: a written argument after a spread would land at a position
 * only the spread's runtime length knows.
 */
const declaredTupleSpreadPositionAt = (checker: ts.TypeChecker, args: readonly ts.Expression[], index: number): ts.Type | null => {
  const spreadAt = args.findIndex(ts.isSpreadElement)
  if (spreadAt === -1 || spreadAt !== args.length - 1 || index < spreadAt) return null
  const spread = args[spreadAt]
  if (!spread || !ts.isSpreadElement(spread) || !ts.isIdentifier(spread.expression)) return null
  const declaration = checker.getSymbolAtLocation(spread.expression)?.valueDeclaration
  if (!declaration || !ts.isParameter(declaration)) return null
  return declaredClosedTupleRestElementsOf(checker, declaration)?.[index - spreadAt] ?? null
}

export const censusParameterBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  /**
   * A previously composed census this round may read from, the same way
   * `withReturnBindings` and `withLocalBindings` already take one.
   *
   * `censusParameterBindings` used to be the one census with no upstream at
   * all: `return-bindings.ts` and `local-bindings.ts` both compose OVER its
   * output, but nothing ever composed back INTO it, so it answered every
   * question -- including "what does this call site's argument hold" -- with
   * only the checker's own evidence and its own internal fixpoint. That is
   * why `texture`, `attribute` and `geometry` stayed `any` in the three.js app even
   * after the other two censuses learned their receivers: those parameters'
   * call sites pass expressions -- `state.buffers`, `const me = m.elements`
   * one step removed -- whose types only exist once a LATER census has run,
   * and by the time it runs this one has already finished.
   *
   * Feeding a prior round's composed census in here as `upstream` closes that
   * gap for a second round: `known()` below consults it exactly where it
   * already falls back from "the checker has no answer" to "keep looking",
   * ahead of this census's own machinery reconstructing one from scratch.
   * `emptyParameterBindingCensus` (round one, and every other caller) makes
   * this identical to the unparameterized behaviour before -- `?? null` never
   * changes an answer this module already had.
   *
   * ⛔ This is also the reason `binding-fixpoint.ts` carrying only
   * `.parameters` across the round boundary (never `.facts.valueFlow`) does
   * NOT stop a finished round's `ValueFlowIndex` from staying reachable.
   * `known()` and `computeStatedTypeAt()` below close over BOTH `valueFlow`
   * (this round's own) and `upstream` (this round's WHOLE argument, not a
   * snapshot of it) so they can answer a node neither has seen yet. The
   * object this function returns is exactly `upstream` for the NEXT round --
   * so round N+1's `typeAt` closes over round N's `typeAt`, which closes over
   * round N-1's, back to round one. `sourceValueSessionOf`
   * (`flow/source-value-session.ts`) memoizes a ~1 GB dependency-solver
   * session in a WeakMap keyed on the `ValueFlowIndex` object identity, so
   * every round on this chain that was ever asked a call-target/receiver
   * question keeps its whole session alive for as long as `settled.parameters`
   * (`frontend.ts`) is reachable -- which is the rest of the compile. Measured
   * on the three.js app: 4 rounds, 4 live `[SOLVER]` sessions at exit, not 1.
   *
   * Not cut here. Forcing `known()`/`computeStatedTypeAt()` to resolve eagerly
   * instead of lazily falling through to `upstream` would answer a node
   * before the round that can actually answer it has run -- the exact
   * pending-read-as-decided collapse `SEMANTIC-AUTHORITY.md` §2(b) names.
   * Truncating the chain (answering from this round's own evidence only,
   * dropping `upstream` once this round stops being the fixpoint's active
   * `previousCensus`) is answer-preserving only if no node reachable after
   * that point was going to need a fact this round's own machinery never
   * independently derived -- true for the RECORDED node set the convergence
   * check in `binding-fixpoint.ts` verifies, unproven for the unbounded set of
   * nodes `frontend.ts` and every downstream producer query afterward, and
   * unverifiable here since the emitted-set gate is off-limits mid-measurement.
   * A real fix has `typeAt`/`statedTypeAt`/`patternReadTypeAt` take the
   * requesting round's own `ValueFlowIndex` as a call-time argument instead of
   * a captured one, which is a migration of the shared `ParameterBindingCensus`
   * surface (`return-bindings.ts`, `local-bindings.ts`, `field-bindings.ts`,
   * `structural.ts`, every producer that calls `typeAt`), not a change
   * confined to this file.
   */
  upstream: ParameterBindingCensus = emptyParameterBindingCensus,
  /**
   * The program index every round shares. Defaulted so a caller that runs the
   * census once needs no change; `frontend.ts`, which runs it up to eight
   * times, builds it once and passes it.
   */
  index: ParameterBindingProgramIndex = indexParameterBindingProgram(checker, files, reachable),
  /**
   * The current round's value-flow facts. The reusable program index owns
   * syntax discovery, not the evolving call attribution and collection edges.
   * A one-shot census can use its index's flow; a composed census must receive
   * the same round snapshot as the field, local, return and collection censuses.
   */
  valueFlow: ValueFlowIndex = index.valueFlow
): ParameterBindingCensus => {
  /** Every call this program makes, grouped by the declaration its signature resolved to. */
  const callsByDeclaration = new Map<ts.Declaration, (ts.CallExpression | ts.NewExpression)[]>()
  const callTargets = new Map<ts.CallExpression | ts.NewExpression, ts.SignatureDeclaration[]>()
  const resolvedCallDeclarations = new Map<ts.CallExpression | ts.NewExpression, ts.SignatureDeclaration | ts.JSDocSignature>()
  /**
   * A `.call`/`.apply` wrapper whose receiver's checker type gave
   * `unwrapExplicitThisCall` no call signature to unwrap statically (an
   * untyped JS array element, `array[ i ].call( this, event )`), authenticated
   * here instead by the SAME closed-array proof `aliasDeclarationsFor` already
   * asks for TYPE attribution just below -- see its own comment. Feeds
   * `indexValueFlow`'s `censusExplicitThisAt` on the NEXT round, so the
   * operand frame this round proved sound becomes the one the whole flow
   * index (argument-to-parameter binding included, not just target
   * resolution) is built from, rather than staying a second reading nobody
   * downstream of `site.operands` would ever see.
   */
  const pendingExplicitThisReadings = new Map<ts.CallExpression, ExplicitThisCallFrame>()
  /**
   * Built once by `indexParameterBindingProgram` and shared by every round --
   * see its doc. `callsByDeclaration` above is the one index that is NOT
   * shared: `attributeCalls` rewrites it as bindings improve.
   */
  const {
    allCalls,
    checkerAttribution,
    invocationOperands,
    aliasEvidence,
    overridesOfBaseMethod,
    siblingMemberDeclarations,
    assignedEvidence
  } = index
  const protocolLedger = deferredIntrinsicProtocolLedgerOf(valueFlow)
  const protocolRequirements = new Map<ts.Node, readonly IntrinsicProtocolRequirement[]>()
  const upstreamProtocolRequirements = protocolLedger?.requirements() ?? []

  /** What each bound parameter declaration now holds. */
  const bindings = new Map<ts.ParameterDeclaration, ts.Type>()
  /** Synthesized union arms for a disjointly-disagreeing parameter -- see `agreedArgumentType`. */
  const unionArms = new Map<ts.ParameterDeclaration, readonly ts.Type[]>()
  // A synthesized parameter union is also a value read by sibling parameter
  // inference. Publishing only unionArmsAt lets structural layout see it while
  // a forwarding call sees no type at all. Materialize the same admitted arms
  // through the shared checker union helper, without adding new alternatives.
  const unionTypes = new Map<ts.ParameterDeclaration, ts.Type | null>()
  const parameterTypeOf = (parameter: ts.ParameterDeclaration): ts.Type | null => {
    const bound = bindings.get(parameter)
    if (bound) return bound
    const arms = unionArms.get(parameter)
    if (!arms) return null
    if (!unionTypes.has(parameter)) unionTypes.set(parameter, disjointUnionTypeOf(checker, arms))
    return unionTypes.get(parameter) ?? null
  }
  /** What each array-pattern element reads before its default -- see `patternReadTypeAt`. */
  const patternReadTypes = new Map<ts.BindingElement, ts.Type>()
  /** Physical object arms proven by flow narrowing of an open dynamic-object upper bound. */
  const flowCarrierArms = new Map<ts.ParameterDeclaration, readonly ts.Type[]>()
  const flowCarrierBounds = new Map<ts.ParameterDeclaration, ts.Type>()

  /**
   * Whether every reference to this function's name is a call this census
   * counted. A function nothing holds as a value has exactly the callers this
   * enumeration found, which is what makes binding from them sound.
   */

  /**
   * A returned record is a real callable flow edge, not an unknown escape,
   * when its property declaration and complete value-flow inventory show only
   * attributed calls. This is the same negative proof as the direct-name
   * check below, applied one level farther out: accepting the object literal
   * merely because it *looks* like a return would let an unobserved
   * `record[key]()` call narrow an implicit-arguments frame from a partial
   * sample.
   */
  /**
   * Whether every value a cell can hold was ALLOCATED here -- following a
   * write that merely FORWARDS another cell's value into it.
   *
   * A factory result reaches its reader by being PASSED. Three builds `state`
   * once in `WebGLRenderer` and hands it to `WebGLTextures`, so the cell this
   * proof actually examines is `WebGLTextures`'s own `state` parameter, whose
   * only write is the argument edge naming `state` -- a bare identifier.
   * Refusing that outright refused the ordinary way a record travels, which
   * is the very case the caller's own comment describes, and it proved
   * nothing: an identifier names a cell whose writes this same index holds,
   * so the question is answerable one hop out rather than unanswerable. All
   * ten of `WebGLState`'s `arguments` shims died here.
   *
   * A forward is followed only to a cell whose OWN writes satisfy the same
   * test, so nothing is admitted that an allocation does not ultimately back.
   * A cycle answers `true` because some other write in it must still be an
   * allocation for the cell to hold anything at all; every other value kind
   * stays the refusal it was.
   */
  const cellHoldsOnlyAllocations = (symbol: ts.Symbol, seen: Set<ts.Symbol>): boolean => {
    if (seen.has(symbol)) return true
    seen.add(symbol)
    // A PARAMETER's write inventory is its argument edges, so it is complete
    // only while every call site is counted -- the same obligation the
    // factory itself is already held to a few lines above.
    const declaration = symbol.valueDeclaration
    if (declaration && ts.isParameter(declaration)) {
      const owner = ts.findAncestor(declaration, isTrackedCallable)
      if (!owner || escapeReason(owner, true) !== null) return false
    }
    for (const write of valueFlow.writesToSymbol(symbol)) {
      if (write.slot !== 'whole' || write.value === null) continue
      const value = write.value
      if (ts.isCallExpression(value) || ts.isNewExpression(value) || ts.isObjectLiteralExpression(value)) continue
      if (ts.isIdentifier(value)) {
        const forwarded = valueFlow.targetOf(value)?.symbol
        if (forwarded && cellHoldsOnlyAllocations(forwarded, seen)) continue
      }
      return false
    }
    return true
  }

  /** Why the published-member proof gave up, for `GEA_ESCAPE_DEBUG`; always `false`, so it reads as the refusal it replaces. */
  const escapeTrace = (member: ts.Symbol, reason: string): false => {
    if (process.env['GEA_ESCAPE_DEBUG']) console.error(`[ESCAPE-PUBLISHED] ${member.name} ${reason}`)
    return false
  }

  const publishedMemberUsesAreCounted = (member: ts.Symbol, counted: ReadonlySet<ts.Node>): boolean => {
    // Property symbols are late-bound by the checker: two lookups of the
    // same inferred member commonly produce distinct Symbol objects.  The
    // declaration node is the stable identity shared by value-flow and the
    // alias index, so use it for the completeness proof.
    const declarations = member.declarations ?? []
    const accesses = declarations.flatMap((declaration) => valueFlow.referencesToDeclaration(declaration))
    // An empty set is not a proof. It means this property's value-flow index
    // could not connect the publication to a use, so retaining the dynamic
    // checker frame is safer than inferring from no calls.
    if (accesses.length === 0) return escapeTrace(member, 'no-accesses')
    const publication = declarations[0]
    const factory = publication && ts.findAncestor(publication, isTrackedCallable)
    const objectLiteral = publication?.parent
    const directReturn =
      objectLiteral &&
      ts.isObjectLiteralExpression(objectLiteral) &&
      ts.isReturnStatement(objectLiteral.parent) &&
      objectLiteral.parent.expression === objectLiteral
    if (!directReturn) return escapeTrace(member, 'not-a-direct-return')
    // Every factory result is an ownership instance. If the factory has more
    // than one call site, a result that never exposes this member can still
    // escape through an unknown API. A single attributed call is the smallest
    // closed publication set this proof can establish without inventing a
    // result-to-receiver correspondence.
    if (!factory) return escapeTrace(member, 'no-factory')
    if ((callsByDeclaration.get(factory)?.length ?? 0) !== 1)
      return escapeTrace(member, `factory-call-sites=${callsByDeclaration.get(factory)?.length ?? 0}`)
    const factoryEscape = escapeReason(factory, true)
    if (factoryEscape !== null) return escapeTrace(member, `factory-escapes:${factoryEscape}`)
    const receivers = new Set<ts.Symbol>()
    for (const reference of accesses) {
      if (ts.isElementAccessExpression(reference)) return false
      if (ts.isPropertyAccessExpression(reference)) {
        if (!counted.has(reference)) return false
        // A receiver with no named cell (`factory().method()` or
        // `{ api: factory() }.api.method()`) has no complete use inventory.
        // Refuse it rather than treating the one visible call as the whole
        // factory-result flow.
        if (!ts.isIdentifier(reference.expression)) return escapeTrace(member, 'receiver-not-a-named-cell')
        const receiver = valueFlow.targetOf(reference.expression)
        if (receiver?.symbol) receivers.add(receiver.symbol)
        continue
      }
      if (ts.isIdentifier(reference)) {
        const parent = reference.parent
        if (ts.isPropertyAccessExpression(parent) && parent.name === reference && counted.has(parent)) continue
        if (ts.isPropertyAssignment(parent) && (parent.name === reference || parent.initializer === reference)) continue
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === reference) continue
        return escapeTrace(member, `identifier-use:${ts.SyntaxKind[parent.kind]}`)
      }
      return escapeTrace(member, `reference-kind:${ts.SyntaxKind[reference.kind]}`)
    }
    // A factory result can be safely kept as a record while its members are
    // read, but passing the record itself through another cell/API is an
    // escape the member census cannot enumerate.  Check the shared reference
    // inventory for every named receiver discovered above; a property read
    // is a closed use, every other use is a leak (including object spread,
    // assignment, and an unknown call argument).
    if (receivers.size === 0) return escapeTrace(member, 'no-named-receivers')
    for (const receiver of receivers) {
      if (!cellHoldsOnlyAllocations(receiver, new Set())) return escapeTrace(member, 'receiver-holds-more-than-allocations')
      const references = valueFlow.referencesToSymbol(receiver)
      if (references.length === 0) return escapeTrace(member, 'receiver-has-no-references')
      for (const reference of references) {
        if (!ts.isIdentifier(reference)) continue
        const type = checker.getTypeAtLocation(reference)
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return escapeTrace(member, `receiver-${receiver.name}-is-any`)
        const parent = reference.parent
        if (ts.isVariableDeclaration(parent) && parent.name === reference) continue
        if (ts.isBindingElement(parent) && parent.name === reference) continue
        // A parameter's own name declares the cell; it is no more a use of the
        // record than a variable declaration's name is. Omitting it refused
        // every receiver that arrives as a parameter, which is every receiver
        // a factory result is passed to.
        if (ts.isParameter(parent) && parent.name === reference) continue
        if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) continue
        return escapeTrace(member, `receiver-use:${ts.SyntaxKind[parent.kind]}`)
      }
    }
    return true
  }

  /** The member symbol published by an object-literal property value. */
  const publishedMemberOf = (reference: ts.Expression): ts.Symbol | null => {
    const parent = reference.parent
    if (ts.isPropertyAssignment(parent) && parent.initializer === reference) {
      const name = parent.name
      if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name) && !ts.isNumericLiteral(name)) return null
      return checker.getTypeAtLocation(parent.parent).getProperty(name.text) ?? null
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === reference) {
      return checker.getTypeAtLocation(parent.parent).getProperty(parent.name.text) ?? null
    }
    return null
  }

  const isDirectReturnedPublication = (reference: ts.Expression): boolean => {
    const parent = reference.parent
    if (!ts.isPropertyAssignment(parent) && !ts.isShorthandPropertyAssignment(parent)) return false
    const objectLiteral = parent.parent
    return (
      ts.isObjectLiteralExpression(objectLiteral) &&
      ts.isReturnStatement(objectLiteral.parent) &&
      objectLiteral.parent.expression === objectLiteral
    )
  }

  /** Match an inferred member through its stable declaration, not Symbol identity. */
  const publishedDeclarationsFor = (member: ts.Symbol): ReadonlySet<ts.SignatureDeclaration> | undefined => {
    const direct = aliasEvidence.publishedUnderMember.get(member)
    if (direct) return direct
    const declarations = member.declarations ?? []
    if (declarations.length === 0) return undefined
    let result: Set<ts.SignatureDeclaration> | undefined
    for (const [candidate, values] of aliasEvidence.publishedUnderMember) {
      if (!(candidate.declarations ?? []).some((declaration) => declarations.includes(declaration))) continue
      if (!result) result = new Set()
      for (const value of values) result.add(value)
    }
    return result
  }

  const callbackContracts = new Map<ts.SignatureDeclaration, readonly CallbackParameterContract[] | null>()
  const memberOpenUses = new Map<ts.SignatureDeclaration, { readonly reference: ts.Expression; readonly kind: string }[]>()
  const contractsFor = (declaration: ts.SignatureDeclaration): readonly CallbackParameterContract[] | null => {
    const cached = callbackContracts.get(declaration)
    if (cached !== undefined) return cached
    const result = callbackParameterContractsFor(checker, valueFlow, declaration, new Set(callsByDeclaration.get(declaration) ?? []))
    callbackContracts.set(declaration, result)
    return result
  }
  const escapeReason = (declaration: ts.SignatureDeclaration, requireCountedReferences = false): string | null => {
    memberOpenUses.delete(declaration)
    const name = nameOfCallable(declaration)
    if (!name) return `function-escapes:unnamed:${declaration.parent ? ts.SyntaxKind[declaration.parent.kind] : 'root'}`
    const symbol = checker.getSymbolAtLocation(name)
    if (!symbol) return 'function-escapes:no-symbol'
    const calls = callsByDeclaration.get(declaration) ?? []
    // The receiving formal publishes a complete callback input contract only
    // when every use of this function is accounted for by the shared flow.
    // This is parameter evidence, not the stricter single-publication proof
    // used by factory/receiver analyses elsewhere in this census.
    const memberClosed = (member: ts.Symbol): boolean =>
      hasClosedMemberCallableUses(
        checker,
        valueFlow,
        member,
        new Set(calls),
        memberClosureReceiverTypeAt,
        implicitArgumentsUsesAt,
        (reference, kind) => {
          const path = memberOpenUses.get(declaration) ?? []
          if (!path.some((entry) => entry.reference === reference && entry.kind === kind)) path.push({ reference, kind })
          memberOpenUses.set(declaration, path)
        }
      )
    // A method is carried by every instance of its class family, and one that
    // never names `.m` still hands unknown code a way to call it: after
    // `globalThis.unknownConsumer( new A() )` that code can run `m` with any
    // argument, or replace it on the shared prototype. The member-name
    // inventory below sees only the mentions; the member proof also walks
    // every construction of the family -- the obligation a function-valued
    // slot already owes just below.
    // ⛔ UNSOUND MEASUREMENT ARM (`GEA_MEMBER_ESCAPE_FORCE=<member>[,<member>]|*`):
    // prices what the member-closure obligation alone is holding open, for one
    // named method or for all of them. Never set it for a build whose output is
    // kept -- it admits a method the program can replace, or call with
    // arguments no site here counted.
    const escapeForce = process.env['GEA_MEMBER_ESCAPE_FORCE']
    const forced = escapeForce !== undefined && (escapeForce === '*' || escapeForce.split(',').includes(symbol.getName()))
    if (ts.isMethodDeclaration(declaration) && !forced && !memberClosed(symbol)) return 'function-escapes:uncounted-member-reference'
    // An export is a mention no expression spells. Code outside the stated
    // module set can call it -- `inProgramImportReferencesOf` answers null
    // then -- and every in-program importer's mention must be a counted call,
    // exactly as the declaring module's own mentions are below.
    if (ts.isFunctionDeclaration(declaration) && isModuleExportedDeclaration(checker, declaration, symbol)) {
      const imported = inProgramImportReferencesOf(checker, valueFlow, declaration)
      if (imported === null) return 'function-escapes:exported'
      const callees = new Set<ts.Node>(
        calls.map((call) => (ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : call))
      )
      if (!imported.every((mention) => callees.has(mention))) return 'function-escapes:uncounted-import'
    }
    if (!requireCountedReferences && contractsFor(declaration) !== null) return null
    const publication = declaration.parent
    const inlineMemberPublication =
      (ts.isPropertyAssignment(publication) && publication.initializer === declaration) ||
      (ts.isBinaryExpression(publication) &&
        publication.right === declaration &&
        publication.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(publication.left) || ts.isElementAccessExpression(publication.left)))
    const publishedMember = ts.isPropertyAssignment(publication)
      ? checker.getSymbolAtLocation(publication.name)
      : ts.isBinaryExpression(publication) && ts.isPropertyAccessExpression(publication.left)
        ? checker.getSymbolAtLocation(publication.left.name)
        : ts.isBinaryExpression(publication) && ts.isElementAccessExpression(publication.left)
          ? checker.getSymbolAtLocation(publication.left)
          : undefined
    if ((ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && inlineMemberPublication && !publishedMember)
      return 'function-escapes:unresolved-published-member'
    if (
      (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) &&
      inlineMemberPublication &&
      (!publishedMember || !memberClosed(publishedMember))
    )
      return 'function-escapes:uncounted-member-reference'
    const counted = new Set<ts.Node>(calls.map((call) => (ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : call)))
    // Ordinary inference keeps its member-name inventory. The strict path
    // needs full declaration-keyed expression references to prove publication
    // closure, including shorthand values and receiver aliases.
    const references = requireCountedReferences
      ? (symbol.declarations ?? []).flatMap((declaration) => valueFlow.referencesToDeclaration(declaration))
      : valueFlow.memberReferencesToSymbol(symbol)
    for (const reference of references) {
      if (counted.has(reference)) continue
      if (requireCountedReferences) {
        if (reference === name || isTypePositionReference(reference)) continue
        const access = reference.parent
        // `export { f }`, `export { f as g } from`, `import { f }`: the binding,
        // not a use. It is closed when nothing outside the stated module set
        // can reach it and every importer mention it leads to is counted.
        if (ts.isExportSpecifier(access) || ts.isImportSpecifier(access) || ts.isImportClause(access) || ts.isNamespaceImport(access)) {
          const exposure = inProgramImportReferencesOf(checker, valueFlow, ts.isExportSpecifier(access) ? access : declaration)
          if (exposure !== null && exposure.every((mention) => counted.has(mention))) continue
          return 'function-escapes:uncounted-import'
        }
        if ((ts.isCallExpression(access) || ts.isNewExpression(access)) && isCalleeOf(reference, access) && counted.has(access.expression))
          continue
        if (ts.isPropertyAccessExpression(access) && access.name === reference && counted.has(access)) continue
        const publishedMember = publishedMemberOf(reference)
        const publicationOwner = publishedMember?.declarations?.[0] && ts.findAncestor(publishedMember.declarations[0], isTrackedCallable)
        if (publishedMember && publicationOwner === declaration && isDirectReturnedPublication(reference)) continue
        // The record's uses reach past one cell -- three's `WebGLState` is
        // handed to `WebGLTextures` and kept on `renderer.state` -- and the
        // shared member proof is the one that walks call arguments and
        // fields: every mention of the slot a counted call, every receiver of
        // the record closed.
        if (
          publishedMember &&
          publishedDeclarationsFor(publishedMember)?.has(declaration) === true &&
          (publishedMemberUsesAreCounted(publishedMember, counted) || memberClosed(publishedMember))
        )
          continue
        // WHICH half of the published-member proof failed is the only thing a
        // reader needs here, and the refusal string cannot carry it: all four
        // ways to miss spell the same word. `WebGLState`'s ten `arguments`
        // shims are refused here and nothing said which.
        if (process.env['GEA_ESCAPE_DEBUG']) {
          const site = reference.getSourceFile()
          console.error(
            `[ESCAPE] ${nameOfCallable(declaration)?.getText() ?? '<anonymous>'} uncounted at ` +
              `${site.fileName.split('/').pop()}:${site.getLineAndCharacterOfPosition(reference.getStart()).line + 1} ` +
              `"${reference.parent?.getText().replace(/\s+/g, ' ').slice(0, 60) ?? ''}" ` +
              `published=${publishedMember ? publishedMember.name : 'none'} ` +
              `owns=${publishedMember ? String(publishedDeclarationsFor(publishedMember)?.has(declaration) === true) : '-'} ` +
              `usesCounted=${publishedMember ? String(publishedMemberUsesAreCounted(publishedMember, counted)) : '-'} ` +
              `memberClosed=${publishedMember ? String(memberClosed(publishedMember)) : '-'}`
          )
        }
        return 'function-escapes:uncounted-reference'
      }
      if ((ts.isIdentifier(reference) || ts.isPrivateIdentifier(reference)) && isBindingOnlyReference(reference)) continue
      if (isTypePositionReference(reference)) continue
      const parent = reference.parent
      if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && isCalleeOf(reference, parent)) continue
      return `function-escapes:${parent ? ts.SyntaxKind[parent.kind] : 'root'}`
    }
    return null
  }

  /**
   * A resolver, in one of the two strengths this census needs.
   *
   * `lateAssignment` is the difference, and it is a soundness boundary rather
   * than a tuning knob. `let extensions;` filled later by `extensions = new
   * WebGLExtensions( _gl )` tells you exactly what the CALL passes -- the call
   * is downstream of the assignment -- so binding a parameter from it is right.
   * It does not tell you what the variable's own CELL holds, because that cell
   * begins empty. Publishing the assignment's type for the cell asks the
   * compiler to convert `null` into a `class-ref`, which is what preflight
   * reported the moment this was tried both ways: twelve new
   * `binding-read-conversion:null->...` obligations, one per late-filled
   * binding in three's renderer.
   *
   * So the strong resolver propagates and the weak one publishes. A variable
   * the weak resolver will not answer for stays exactly as it is today --
   * boxed -- and the unboxing happens at the call boundary, where the value
   * really has arrived.
   */
  /**
   * `this`, read at its own keyword inside an ordinary (non-static) class
   * method, checks as the POLYMORPHIC self type -- `typeToString` spells it
   * literally `this` -- because the checker is answering for every possible
   * subclass, not this one. That is the right answer for the METHOD's own
   * signature, but wrong the moment `this` is READ as a plain value and
   * handed somewhere else: `object.onBeforeRender( this, object )` passes
   * the calling `Renderer`, not an unspellable self-type, and a parameter
   * bound from it must carry the concrete class the same way any other
   * argument's checker type does.
   *
   * Mirrors `structural-receiver.ts`'s `implicitReceiverOf`, which resolves
   * the identical instance case to `checker.getDeclaredTypeOfSymbol` on the
   * owning class for the ABI's receiver frame; this is the same fact, read
   * for a value use rather than a calling convention. Deliberately narrow:
   * only the plain instance-method shape is resolved here, and everything
   * else -- static methods, object-literal methods, a `this` the checker
   * cannot place at all -- falls through to the checker's own answer
   * unchanged.
   */
  // Memoized because it is a pure function of the node and this census's own
  // checker, and `known` -- which asks it for every `this` it meets -- runs
  // thousands of times per sweep. Each miss walks the AST to the enclosing
  // non-arrow function, which for a `this` deep inside a method body is the
  // whole chain of enclosing nodes, re-walked per mention.
  const concreteThisTypes = new WeakMap<ts.Node, ts.Type | null>()
  const concreteThisTypeOf = (keyword: ts.Node): ts.Type | null => {
    const known = concreteThisTypes.get(keyword)
    if (known !== undefined) return known
    if (concreteThisTypes.has(keyword)) return null
    const answer = concreteThisTypeUncached(keyword)
    concreteThisTypes.set(keyword, answer)
    return answer
  }
  const concreteThisTypeUncached = (keyword: ts.Node): ts.Type | null => {
    const frame = ts.findAncestor(keyword, (node) => ts.isFunctionLike(node) && !ts.isArrowFunction(node))
    if (frame === undefined || !ts.isFunctionLike(frame)) return null
    if ((ts.getCombinedModifierFlags(frame as ts.Declaration) & ts.ModifierFlags.Static) !== 0) return null
    const holder = frame.parent
    if (!ts.isClassDeclaration(holder) && !ts.isClassExpression(holder)) return null
    if (!holder.name) return null
    const symbol = checker.getSymbolAtLocation(holder.name)
    return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
  }
  /** `GEA_KNOWN_DEBUG=<identifier>` reports, for every mention of that name,
   * what the checker answers, whether the vacuous-evidence guard fires, and
   * what the upstream round already knew -- which is the one place a fact that
   * exists in the settled census but not in a proof shows itself. Read once:
   * `known` runs thousands of times per sweep. */
  const watchedBinding = process.env['GEA_KNOWN_DEBUG']
  const createResolver = (lateAssignment: boolean) => {
    // Memoized per round: a binding learned this round changes what a later
    // question answers, so a memo that outlived the round would answer with the
    // previous round's smaller view.
    let memo = new Map<ts.Node, ts.Type | null>()
    const resolving = new Set<ts.Node>()

    /**
     * The type this node holds, following a bound parameter through the
     * expressions computed from it.
     *
     * Every step delegates to the checker: a member is `getTypeOfPropertyOfType`,
     * a call is the return type of a signature the checker resolved. The walk
     * bottoms out ONLY at a bound parameter -- a node whose chain does not reach
     * one answers `null` and keeps the checker's own answer -- which is what
     * keeps a genuinely dynamic value dynamic.
     */
    const resolve = (node: ts.Node): ts.Type | null => {
      const cached = memo.get(node)
      if (cached !== undefined) return cached
      if (resolving.has(node)) return null
      resolving.add(node)
      const answer = compute(node)
      resolving.delete(node)
      memo.set(node, answer)
      return answer
    }

    /**
     * The checker's answer when it is a real one, so a resolved chain stops as
     * soon as a type is known -- or, when the checker has nothing, the
     * upstream census's answer for this exact node. `upstream` is a settled
     * prior round (or `emptyParameterBindingCensus`, which always answers
     * `null` and changes nothing): consulting it here, ahead of this
     * resolver's own machinery, is what lets a second round see a fact only
     * `return-bindings.ts`/`local-bindings.ts` derived -- without this
     * resolver having to reconstruct that fact itself.
     */
    const known = (node: ts.Node): ts.Type | null => {
      if (watchedBinding !== undefined && ts.isIdentifier(node) && node.text === watchedBinding) {
        const held = checker.getTypeAtLocation(node)
        const file = node.getSourceFile()
        process.stderr.write(
          `[KNOWN] ${file.fileName.split('/').pop()}#${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
            `checker=${checker.typeToString(held).slice(0, 30)} unusable=${isUnusableEvidence(held)} ` +
            `vacuous=${annotationStatesNothing(checker, node, held)} upstream=${(() => {
              const answer = upstream.typeAt(node)
              return answer ? checker.typeToString(answer).slice(0, 40) : 'null'
            })()}\n`
        )
      }
      const argument = implicitArgumentsReadTypeAt(checker, node, (owner) => upstream.implicitArgumentsTupleAt?.(owner) ?? null)
      if (argument) return argument
      const type =
        (node.kind === ts.SyntaxKind.ThisKeyword ? concreteThisTypeOf(node) : null) ??
        objectAssignTargetType(checker, node) ??
        checker.getTypeAtLocation(node)
      // `annotationStatesNothing` beside `isUnusableEvidence`, both halves of
      // the one shared rule: a vacuous type (`Object`, `{}`, bare `object`)
      // is not merely non-evidence -- handed to a `widestOf` join it
      // DOMINATES, because every type is assignable to it, so one vacuous
      // call site out-votes every real one. The layout resolver and the two
      // write-set censuses already ask both halves; this asking one was
      // drift. See `field-bindings.ts`'s `known` for the measured case.
      if (isUnusableEvidence(type) || annotationStatesNothing(checker, node, type)) return upstream.typeAt(node)
      // A bound parameter's DECLARED type can be one TypeScript widened from a
      // default value -- `constructor( parameters = {} )` declares `{}`, a type
      // with no members, so every `parameters.canvas` reading through it finds
      // nothing. When the checker is reporting that declared type UNCHANGED at
      // this site, the census knows better and should answer.
      //
      // The equality test is what keeps flow narrowing intact: a site where the
      // checker narrowed the value reports a DIFFERENT type than the
      // declaration, and there the checker is right and this defers to it. A
      // census that always won would silently discard every narrowing in the
      // program.
      if (ts.isIdentifier(node)) {
        const declaration = declarationOf(node)
        if (declaration && ts.isParameter(declaration) && bindings.has(declaration)) {
          if (checker.getTypeAtLocation(declaration) === type) return null
        }
        // A name bound by a parameter's implied pattern is typed by the
        // checker from the pattern's SHAPE (`any`, `any[]` for a rest
        // element), which is the silhouette `impliedPatternParameterOf`
        // exists to see through; the pattern's own read is the answer.
        if (declaration && ts.isBindingElement(declaration) && impliedPatternElementRootOf(checker, declaration) !== null) return null
      }
      return type
    }

    const declarationOf = (node: ts.Identifier): ts.Declaration | null => {
      const symbol = checker.getSymbolAtLocation(node)
      const declarations = symbol?.declarations
      return declarations && declarations.length === 1 ? (declarations[0] ?? null) : null
    }

    /**
     * The type of one member of a resolved receiver.
     *
     * `getPropertyOfType` answers with the symbol and `getTypeOfSymbolAtLocation`
     * types it at the site that reads it, which is the pair the checker exposes
     * for exactly this question -- the same answer it computed to check the
     * access, read back rather than recomputed.
     */
    /**
     * The expression a literal member was written with -- `{ color: cb }`, or
     * shorthand `{ cb }` -- or `null` for any other declaration form.
     * `field-bindings.ts` states the same shape for the same reason.
     */
    const literalMemberInitializerOf = (member: ts.Symbol | undefined): ts.Expression | null => {
      const declaration = member?.valueDeclaration
      if (!declaration) return null
      if (ts.isPropertyAssignment(declaration)) return declaration.initializer
      if (ts.isShorthandPropertyAssignment(declaration)) return declaration.name
      return null
    }
    const resolvingLiteralMembers = new Set<ts.Node>()
    /**
     * A member read, answered by the checker -- and, where the checker has no
     * answer, by what the literal actually PUT there.
     *
     * The checker widens an object literal's member to `any` as soon as its
     * initializer is untyped, and in JavaScript a factory's product is exactly
     * that: `function ColorBuffer() { return { setClear: function (...) {} } }`
     * called with `new` has no construct signature, so `cb` is `any` to the
     * checker and so is `{ color: cb }.color`. This census has ALREADY resolved
     * `cb` to the literal it holds -- that is what it exists to do -- and
     * throwing that away at the property assignment is what made three's
     * `state.buffers.color.setClear(...)` unattributable, leaving every method
     * on all three WebGLState buffer literals with no call sites and all their
     * parameters dynamic.
     *
     * Asked only where the checker's own answer is unusable, so nothing that
     * already had a type changes; the recursion guard is for a literal whose
     * member initializer reads back through the same member.
     */
    const propertyTypeOf = (receiver: ts.Type, name: string, at: ts.Node): ts.Type | null => {
      const answer = memberTypeOf(checker, receiver, name, at, valueFlow)
      if (answer !== null && !isUnusableEvidence(answer)) return answer
      // A member only some classes of the receiver's closed family declare:
      // three's `material.glslVersion` through a `Material`. See
      // `flow/class-family-member-read.ts`.
      const family = answer === null ? classFamilyMemberReadTypeOf(checker, valueFlow, receiver, name, upstream) : null
      if (family !== null) return family
      const written = literalMemberInitializerOf(checker.getPropertyOfType(checker.getApparentType(receiver), name))
      if (written === null || resolvingLiteralMembers.has(written)) return answer
      resolvingLiteralMembers.add(written)
      try {
        const resolved = known(written) ?? resolve(written)
        return resolved !== null && !isUnusableEvidence(resolved) ? resolved : answer
      } finally {
        resolvingLiteralMembers.delete(written)
      }
    }

    /**

     * What a function actually returns, when its declared return type is `any`.

     *

     * Only the `return` statements of THIS function: a nested function's returns

     * belong to it, and walking into one would attribute its answer to the wrong

     * frame. Agreement is required for the same reason it is required of a

     * parameter's call sites -- two different types are two answers, and picking

     * one is guessing. A bare `return;` among them is a refusal rather than an

     * agreement: it means the function also returns `undefined`, which the

     * agreed type does not describe.

     */

    const resolvedReturnTypeOf = (declaration: ts.SignatureDeclaration): ts.Type | null => {
      const body = 'body' in declaration ? (declaration.body as ts.Block | ts.Expression | undefined) : undefined

      if (!body) return null

      if (!ts.isBlock(body)) return known(body) ?? resolve(body)

      const returnedTypes: ts.Type[] = []

      let sawReturn = false

      let refused = false

      const walk = (node: ts.Node): void => {
        if (refused) return

        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
          return

        if (ts.isReturnStatement(node)) {
          sawReturn = true

          if (!node.expression) {
            refused = true

            return
          }

          const returned = known(node.expression) ?? resolve(node.expression)

          if (!returned || isUnusableEvidence(returned)) refused = true
          else returnedTypes.push(returned)

          return
        }

        ts.forEachChild(node, walk)
      }

      ts.forEachChild(body, walk)

      return refused || !sawReturn ? null : widestOf(checker, returnedTypes)
    }

    /**
     * What a `var`/`let`/`const` cell holds, read from EVERY write to it.
     *
     * Its initializer is one write; so is every later assignment. `let _gl =
     * context; ... _gl = getContext( contextName, contextAttributes );` in
     * `WebGLRenderer` writes twice, and reading only the initializer would
     * describe a value the program does not have -- the second write is how a
     * context that arrived as `null` gets created, and the cell has to hold
     * both. The writes settling on one carrier is the answer (`widestOf`);
     * anything else is refused.
     *
     * Both the declaration node and every identifier that reads the binding
     * route through here, because they are one cell and one carrier. Answering
     * the declaration from its initializer while answering references from the
     * whole write set is two authorities on one storage location, which is how
     * a cell gets a non-optional carrier and a `null` written into it.
     *
     * `let extensions, capabilities, state, info;` filled later inside
     * `initGLContext()` is the same rule with no initializer among the writes,
     * and it is the hop every chain into three's sub-modules passes through --
     * which is exactly why only the propagating resolver may use it. See
     * `createResolver`.
     */
    const writeSetTypeOf = (declaration: ts.VariableDeclaration): ts.Type | null => {
      if (declaration.type) return null
      if (!declaration.initializer && !lateAssignment) return null
      const edges = valueFlow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
      if (edges.some((write) => write.value === null)) return null
      const writes = edges.flatMap((write) => (write.value === null ? [] : [write.value]))
      if (writes.length === 0) return null
      const writtenTypes: ts.Type[] = []
      for (const write of writes) {
        const written = known(write) ?? resolve(write)
        if (!written || isUnusableEvidence(written)) return null
        writtenTypes.push(written)
      }
      return widestOf(checker, writtenTypes)
    }

    /**
     * The value a whole binding pattern reads out of: a parameter's own bound
     * slot, an outer element's resolved type for a nested pattern, or a
     * declaration's initializer. The pattern node itself resolves to this so
     * a producer asking `typeAt(pattern)` for the base of its steps gets the
     * census's answer rather than the checker's implied-shape type.
     */
    const patternHoldersOf = (pattern: ts.BindingPattern): readonly ts.Type[] | null => {
      const root = pattern.parent
      if (ts.isParameter(root)) {
        // A disagreement the census settled as SYNTHESIZED arms has no single
        // `ts.Type` (`unionArms`), so the pattern reads out of every arm and
        // joins what it finds -- `f([1, 2])` next to `f([])` is that shape.
        const bound = bindings.get(root)
        return bound ? [bound] : (unionArms.get(root) ?? null)
      }
      const holder = ts.isBindingElement(root)
        ? (known(root) ?? resolve(root))
        : ts.isVariableDeclaration(root) && root.initializer
          ? (exactEmptyObjectLiteralType(checker, root.initializer) ?? known(root.initializer) ?? resolve(root.initializer))
          : null
      return holder ? [holder] : null
    }
    const patternHolderOf = (pattern: ts.BindingPattern): ts.Type | null => {
      const holders = patternHoldersOf(pattern)
      return holders && holders.length === 1 ? (holders[0] ?? null) : null
    }

    /**
     * An object pattern's NUMERIC key over a plain array -- `[...{ 0: v, 3: y,
     * length: z }] = [7, 8, 9]` -- reads the array's element WITH `undefined`:
     * position 3 of a three-element array is `undefined` to the language, and
     * a read typed bare aborted at runtime ("read of array hole or out-of-range
     * index"). A tuple holder states its positions, so a stated one answers
     * bare and an unstated one `undefined`; every other key (`length`) is an
     * ordinary member read. Published as the element's READ (`patternReadTypes`)
     * so the layout's outranking rule can lift the checker's bare binding.
     */
    const arrayIndexPatternReadOf = (holder: ts.Type, key: string, element: ts.BindingElement): ts.Type | null => {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return null
      const nonNull = checker.getNonNullableType(holder)
      let read: ts.Type | null = null
      if (checker.isTupleType(nonNull)) {
        const stated = checker.getTypeArguments(nonNull as ts.TupleTypeReference)[Number(key)]
        read = stated === undefined ? checker.getUndefinedType() : checker.getBaseTypeOfLiteralType(stated)
      } else {
        const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
        if (!indexed || isUnusableEvidence(indexed) || checker.getIndexTypeOfType(nonNull, ts.IndexKind.String)) return null
        read = checker.getNullableType(indexed, ts.TypeFlags.Undefined)
      }
      patternReadTypes.set(element, read)
      if (!element.initializer) return read
      const fallback = defaultWriteOf(element.initializer)
      return fallback ? (joinOfWrites(checker, [withoutUndefinedMember(checker, read), fallback]) ?? read) : read
    }

    /**
     * A key the holder's closed object type declares no member for reads
     * `undefined` -- ECMA-262 `KeyedBindingInitialization` reads through
     * `GetV` and finds nothing, so `const { fn = function () {} } = {}` binds
     * the default. The checker binds the name `any` in a JavaScript file (an
     * error in TypeScript), which was enough to box the default's own
     * function type and every `.name`/call on it. Only a single object type
     * with no member of that name and no index signature of either kind
     * answers; a union, a primitive, or an open dictionary keeps the ordinary
     * member read. `getPropertyOfType` sees the apparent members too, so a
     * `{ toString }` pattern over `{}` still reads `Object.prototype`'s.
     */
    const absentKeyPatternReadOf = (holder: ts.Type, key: string, element: ts.BindingElement): ts.Type | null => {
      const nonNull = checker.getNonNullableType(holder)
      if (isUnusableEvidence(nonNull) || (nonNull.flags & ts.TypeFlags.Object) === 0) return null
      if (
        checker.getPropertyOfType(nonNull, key) ||
        checker.getIndexTypeOfType(nonNull, ts.IndexKind.String) ||
        checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
      )
        return null
      const read = checker.getUndefinedType()
      patternReadTypes.set(element, read)
      if (!element.initializer) return read
      return defaultWriteOf(element.initializer) ?? read
    }

    /**
     * One array-pattern element's own type, read out of `holder` the way the
     * language reads it (ECMA-262 IteratorBindingInitialization): a tuple
     * source answers by position; any other array answers its element type
     * WITH `undefined`, because the pattern may run past the array's length
     * and the language binds the name to `undefined` there rather than
     * faulting. A default resolves that absence to the default's own type
     * (`joinOfWrites`, the same nullish-is-absence join a defaulted object
     * element uses in `local-bindings.ts`). A rest element takes the holder's
     * remaining elements, which for a plain array is the same array type.
     */
    const arrayPatternElementTypeOf = (
      holders: readonly ts.Type[],
      element: ts.BindingElement,
      pattern: ts.ArrayBindingPattern
    ): ts.Type | null => {
      const position = pattern.elements.indexOf(element)
      // A parameter's implied pattern reads out of the ARRAY the value is
      // stored as (`impliedPatternElementOfArms`, the same answer the slot
      // takes), not out of the tuple one call site happened to write: the
      // position holds the stored element or nothing, whatever the arms said.
      if (ts.isParameter(pattern.parent) && impliedPatternParameterOf(checker, pattern.parent) !== null && !element.dotDotDotToken) {
        const stored = impliedPatternElementOfArms(checker, holders, pattern)
        if (stored && !isUnusableEvidence(stored)) {
          const own = impliedPatternPositionPresentEverywhere(checker, holders, position)
            ? stored
            : checker.getNullableType(stored, ts.TypeFlags.Undefined)
          patternReadTypes.set(element, own)
          if (!element.initializer) return own
          // The NAME holds the read with its absence replaced by the default
          // (`bodyBindingOf`'s rule for a parameter, one level down): the
          // read is `own`, published above for the pattern step to test,
          // and only a default that itself evaluates to `undefined` can put
          // the absence back. `[[,] = g()]` binding `Generator | undefined`
          // sent the nested pattern reading an optional cursor.
          const fallback = defaultWriteOf(element.initializer)
          return fallback ? (joinOfWrites(checker, [withoutUndefinedMember(checker, own), fallback]) ?? own) : own
        }
      }
      const ownOf = (holder: ts.Type): ts.Type | null => {
        const nonNull = checker.getNonNullableType(holder)
        if (checker.isTupleType(nonNull)) {
          if (element.dotDotDotToken) return null
          const stated = checker.getTypeArguments(nonNull as ts.TupleTypeReference)[position]
          return stated === undefined ? checker.getUndefinedType() : checker.getBaseTypeOfLiteralType(stated)
        }
        const indexed = checker.getIndexTypeOfType(nonNull, ts.IndexKind.Number)
        if (!indexed) {
          // A non-array iterable holder (a generator, a Set, a Map) has no
          // numeric index; a position reads what the holder YIELDS, with
          // `undefined` for a cursor exhausted before it -- the checker binds
          // the name bare, and `var [a, b] = g()` over a one-yield generator
          // then read `0` for `b`. A rest element would need an array of the
          // yield, which no checker API mints, so it stays unanswered.
          if (element.dotDotDotToken) return null
          const yielded = iteratorYieldTypesOf(checker, nonNull, pattern)
          const only = yielded?.length === 1 ? yielded[0] : undefined
          return only && !isUnusableEvidence(only) ? checker.getNullableType(only, ts.TypeFlags.Undefined) : null
        }
        if (isUnusableEvidence(indexed)) return null
        if (element.dotDotDotToken) return nonNull
        return checker.getNullableType(indexed, ts.TypeFlags.Undefined)
      }
      const owns = holders.map(ownOf)
      if (owns.some((type) => type === null)) return null
      // Every arm's position, joined: a position one arm states and another
      // runs past is `T | undefined`, which is what `joinOfWrites` makes of
      // `[T, undefined]` -- the same nullish-is-absence join a default uses.
      const own = owns.length === 1 ? owns[0] : joinOfWrites(checker, owns as ts.Type[])
      if (!own) return null
      patternReadTypes.set(element, own)
      if (!element.initializer) return own
      const fallback = defaultWriteOf(element.initializer)
      return fallback ? (joinOfWrites(checker, [own, fallback]) ?? own) : own
    }

    /** What a default initializer WRITES: a `void` call's value is `undefined`, the language's own answer for it. */
    const defaultWriteOf = (initializer: ts.Expression): ts.Type | null => {
      if ((checker.getTypeAtLocation(initializer).flags & ts.TypeFlags.Void) !== 0) return checker.getUndefinedType()
      return known(initializer) ?? resolve(initializer)
    }

    const compute = (node: ts.Node): ts.Type | null => {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
        return known(node.expression) ?? resolve(node.expression)
      }
      if (ts.isIdentifier(node)) {
        const declaration = declarationOf(node)
        if (!declaration) return null
        if (ts.isParameter(declaration)) return parameterTypeOf(declaration)
        // A binding holds what is written into it, and EVERY write counts. Its
        // initializer is one; so is every later assignment -- `let _gl = context;
        // ... _gl = getContext( contextName, contextAttributes );` in
        // `WebGLRenderer` writes twice, and reading only the initializer would
        // describe a value the program does not have. All the writes agreeing is
        // one answer; anything else is refused rather than merged, because the
        // union that would describe two is not a type this can build without
        // inventing one, and the honest answer to "which of these two" is neither.
        //
        // `let extensions, capabilities, state, info;` filled later inside
        // `initGLContext()` is the same rule with no initializer among the
        // writes, and it is the hop every chain into three's sub-modules passes
        // through -- which is exactly why only the propagating resolver may use
        // it. See `createResolver`.
        // A reference to a destructured name is a read of the SAME storage the
        // pattern bound, so it answers with the pattern's own answer. Without
        // this hop the chain stops one step short of everything it was built
        // for: `const { canvas, context } = parameters` binds both names, and
        // then `canvas.getContext( ... )` -- an ordinary reference, three lines
        // down -- resolves to nothing. A later assignment to the name is the
        // same disqualification it is for a `let`: the binding then holds
        // something the pattern's member type does not describe.
        if (ts.isBindingElement(declaration)) {
          const symbol = checker.getSymbolAtLocation(declaration.name)
          // The pattern's own binding and its own default (`[w = c()]`) are
          // recorded at the element's site; the pattern's answer already
          // joins them. Only a write from somewhere ELSE disqualifies.
          if (symbol && valueFlow.writesToSymbol(symbol).some((write) => write.slot === 'whole' && write.site !== declaration)) return null
          return resolve(declaration)
        }
        if (ts.isVariableDeclaration(declaration)) return writeSetTypeOf(declaration)
        return null
      }
      if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) return patternHolderOf(node)
      if (ts.isBindingElement(node)) {
        // `const { canvas, context, antialias } = parameters` binds three names to
        // three members of one value. The member is the answer, and the value is
        // whatever this resolver can make of the pattern's own root.
        const pattern = node.parent
        if (ts.isObjectBindingPattern(pattern)) {
          const holder = patternHolderOf(pattern)
          const key = node.propertyName ?? node.name
          if (!holder || !(ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key))) return null
          const indexedRead = arrayIndexPatternReadOf(holder, key.text, node)
          if (indexedRead) return indexedRead
          const absentRead = absentKeyPatternReadOf(holder, key.text, node)
          if (absentRead) return absentRead
          return propertyTypeOf(holder, key.text, node)
        }
        const holders = patternHoldersOf(pattern)
        return holders ? arrayPatternElementTypeOf(holders, node, pattern) : null
      }
      if (ts.isPropertyAccessExpression(node)) {
        const receiver = known(node.expression) ?? resolve(node.expression)
        if (!receiver) return null
        return propertyTypeOf(receiver, node.name.text, node)
      }
      if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        const receiver = known(node.expression) ?? resolve(node.expression)
        if (!receiver) return null
        // A literal key is a named member spelled with brackets; any other key
        // is answered by the receiver's index signature, and by nothing else.
        const name = literalMemberNameOf(node)
        if (name !== null) return propertyTypeOf(receiver, name, node)
        const key = known(node.argumentExpression) ?? resolve(node.argumentExpression)
        return key ? indexedTypeOf(checker, receiver, key, node, valueFlow, upstream) : null
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const invariant = overloadInvariantReturnTypeAt(checker, node, (operand) => known(operand) ?? resolve(operand))
        // An OPEN invariant is not one: every overload agreeing on the same
        // unreduced type EXPRESSION says nothing about the type. Falls through
        // rather than returning null, so the ordinary path below still gets its
        // turn -- and refuses the same form for the same reason.
        if (invariant && !isUnreducedTypeForm(invariant)) return invariant
        const callee = known(node.expression) ?? resolve(node.expression)
        if (!callee) return null
        // A JavaScript factory called with `new` that returns an object is typed
        // by what it returns, which is why the call signature is consulted for a
        // `new` whose callee declares no construct signature -- `new
        // WebGLExtensions( _gl )` is `function WebGLExtensions( gl ) { ...;
        // return { has, init, get }; }`, and the record it returns is the whole
        // of what the expression holds.
        const constructed = ts.isNewExpression(node) ? callee.getConstructSignatures() : []
        const signatures = constructed.length > 0 ? constructed : callee.getCallSignatures()
        if (signatures.length !== 1) return null
        const signature = signatures[0] as ts.Signature
        const operands = ts.isCallExpression(node) ? invocationOperands.get(node) : undefined
        if (ts.isCallExpression(node) && !operands) return null
        const returned = explicitThisCallReturnType(
          signature,
          operands?.explicitThis ? (known(operands.callee) ?? resolve(operands.callee)) : null
        )
        // `void` and `never` are refused here for the reason `isUnusableEvidence`
        // states, and `any` falls through to the return-expression walk below
        // rather than being refused -- the three answers are not one answer.
        if ((returned.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) return null
        // A GENERIC signature's declared return is an OPEN FORM, and reading it
        // off the signature publishes the type expression rather than the type.
        // `Reflect.get(pattern, 'route')` is the case: one call signature,
        // `P extends keyof T ? T[P] : any`, and nothing on this walk binds `T`
        // or `P` -- so the census answered a conditional that no later stage
        // can reduce, `structural.ts` refused it as "an anonymous conditional
        // type is still gated on a type parameter", and a program whose call
        // the CHECKER had already reduced to `any` lost its certificate.
        //
        // Refused rather than instantiated: instantiating is what the checker
        // did at the call site, and its answer is the one `layoutTypeAt` falls
        // back to the moment this census declines. Doing it a second time here
        // would be a second authority on the same reduction.
        //
        // Asked of the ANSWER, not of the signature. The signature reached here
        // came off a census-derived callee type, and its `getTypeParameters()`
        // is empty even where its return type is still open -- so gating on the
        // signature being generic left this exact case through.
        if (isUnreducedTypeForm(returned)) return null
        // A stated return type that says NOTHING falls through with `any`, for
        // the same reason and by the same rule. `function makesBag(): object {
        // return { a: 1, b: 2 } }` answered `object` here, and because this
        // census's answer is the FIRST half of the composed view
        // (`composeReturnBindings`), that shadowed the return census's own,
        // already-derived record for the same call -- two authorities on one
        // invocation, which `model/selected-signature.ts` catches fail-closed
        // and pays for by withholding the call AND every binding it feeds.
        if (!isAnyType(returned)) return returned
        // The return type was not written down either. A function's `return`
        // expressions are the same kind of evidence a call's arguments are,
        // and asking them is the same question one frame down: `getContext`
        // returns `canvas.getContext( ... )`, and once `canvas` is known so is
        // this.
        const declared = signature.declaration
        return declared && ts.isFunctionLike(declared) ? resolvedReturnTypeOf(declared) : null
      }
      if (ts.isVariableDeclaration(node)) return writeSetTypeOf(node)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return known(node.right) ?? resolve(node.right)
      }
      // Last, and through the SHARED resolver rather than a local reading of
      // these node kinds. `return-bindings.ts` asks the identical question of
      // the identical expressions, and two censuses answering it two ways is
      // the defect class this compiler keeps rediscovering -- so the rule lives
      // in one module and both callers hand it their own operand resolver.
      // Deliberately after the assignment arm above: a `BinaryExpression` whose
      // operator is `=` is a write, answered by its right-hand side, and only
      // the operators that COMPUTE a value reach here.
      if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
        return derivedExpressionType(checker, node, (operand) => known(operand) ?? resolve(operand))
      }
      return null
    }

    return {
      resolve,
      known,
      reset: (): void => {
        memo = new Map<ts.Node, ts.Type | null>()
      }
    }
  }

  const propagating = createResolver(true)
  // One pair of key functions per index: the member-closure memo keys on
  // their identity, and a closure minted per proof launch defeats it.
  const propagatingTypeAt = (expression: ts.Expression): ts.Type | null => propagating.known(expression) ?? propagating.resolve(expression)
  const implicitArgumentsUsesAt = (owner: ts.SignatureDeclaration): readonly ts.Identifier[] | undefined =>
    index.implicitArgumentsUses.get(owner)
  // `hasClosedMemberCallableUses`'s memo is keyed in part on THIS function's
  // identity, which is exactly right for a single whole-program authority --
  // but `bindingSweep` below re-derives `propagatingTypeAt`'s answers every
  // round from a GROWING `bindings` map behind the SAME stable reference, so
  // a member whose closure needs a later round's binding got refused once
  // and served that stale refusal forever after, with no further proof
  // activity to show for it. Reassigned once per round (not per proof
  // launch, which would defeat in-round reuse the comment above protects) so
  // each round's improved evidence gets its own cache generation.
  let memberClosureReceiverTypeAt: (expression: ts.Expression) => ts.Type | null = propagatingTypeAt
  const publishing = createResolver(false)

  /**
   * Whether `call` is a recursive call: attributed to `declaration` (true of
   * every call in `callsByDeclaration.get(declaration)` by construction) AND
   * lexically inside `declaration`'s OWN body -- so this is `declaration`
   * calling itself, directly or through a different receiver of the same
   * method (`children[i].traverse( callback )` inside `Object3D.traverse`'s
   * own body is the same declaration, called again, from within itself).
   *
   * Direct self-reference only, deliberately: mutual recursion (`a` calling
   * `b` calling `a`) needs walking the call graph rather than one
   * containment check, and is worth the extra machinery only once this
   * narrower, measured, cheaply-checked case has proven the shape is worth
   * having at all.
   */
  const isRecursiveCallWithin = (call: ts.CallExpression | ts.NewExpression, declaration: ts.SignatureDeclaration): boolean => {
    const body = 'body' in declaration ? declaration.body : undefined
    if (!body) return false
    for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
      if (current === body) return true
    }
    return false
  }

  /** Whether `expression` (parens aside) is a bare reference to exactly `parameter`'s own declaration. */
  const referencesParameter = (expression: ts.Expression, parameter: ts.ParameterDeclaration): boolean => {
    let current: ts.Expression = expression
    while (ts.isParenthesizedExpression(current)) current = current.expression
    if (!ts.isIdentifier(current)) return false
    const symbol = checker.getSymbolAtLocation(current)
    const declarations = symbol?.declarations
    return declarations !== undefined && declarations.length === 1 && declarations[0] === parameter
  }

  /**
   * Whether a recursive argument's type depends on `parameter`, through only
   * reference-preserving reads this census can replay after the parameter has
   * a provisional binding. Unlike a bare self-reference, a member/element
   * read is not automatically the same type as its receiver: it may name a
   * different field entirely. This predicate therefore only chooses what to
   * DEFER; `validateDeferredRecursiveArguments` below re-resolves the full
   * expression and proves its resulting type fits before publication.
   */
  const isDerivedFromParameter = (expression: ts.Expression, parameter: ts.ParameterDeclaration): boolean => {
    const seen = new Set<ts.Node>()
    const visit = (node: ts.Expression): boolean => {
      let current = node
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
      )
        current = current.expression
      if (seen.has(current)) return false
      seen.add(current)
      if (referencesParameter(current, parameter)) return true
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) return visit(current.expression)
      if (!ts.isIdentifier(current)) return false
      const declarations = checker.getSymbolAtLocation(current)?.declarations
      if (!declarations || declarations.length !== 1) return false
      const declaration = declarations[0]
      if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration))) return false
      return valueFlow
        .writesToDeclaration(declaration)
        .some((write) => write.slot === 'whole' && write.value !== null && visit(write.value))
    }
    return visit(expression) && !referencesParameter(expression, parameter)
  }

  /**
   * One pass over every call attributed to `declaration`, resolving the
   * argument at `index`. `excludeBackEdges` chooses which of the two
   * readings `agreedArgumentType` (below) is asking for: skipping a back
   * edge -- see the module comment above `isRecursiveCallWithin` -- is the
   * sound, information-ADDING reading, and resolving it like any other
   * argument is the fallback for when a back edge is all the evidence
   * there is. `sawBackEdge` tells the caller whether skipping happened at
   * all, so it can tell "every call was a back edge" (this comes back with
   * an empty `passed` AND `sawBackEdge`) apart from "there were simply no
   * calls" (empty `passed`, no back edge) without re-walking `calls`.
   * `skipSilentSites` is the second such choice; see `EVIDENCE EXHAUSTED`.
   */
  const argumentsByParameter = new Map<ts.ParameterDeclaration, Set<ts.Expression>>()
  /**
   * A silent site is one the census has no evidence for YET. A site whose
   * argument is a runtime-keyed read (`obj[name]`) or an ambient member the
   * library declares `any` (`desc.value` on lib's PropertyDescriptor) has no
   * evidence to come: the value is dynamic in every authority. Skipping it
   * and binding the parameter from the other sites would unbox the value at
   * this call -- test262's `isSameValue(desc.value, obj[name])` bound `b` to
   * `string` from `newValue` and aborted on the first numeric `length`.
   */
  const isSuppliedDynamic = (argument: ts.Expression): boolean => {
    let expression: ts.Expression = argument
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression
    const type = checker.getTypeAtLocation(expression)
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return false
    if (ts.isElementAccessExpression(expression)) {
      return !ts.isStringLiteralLike(expression.argumentExpression) && !ts.isNumericLiteral(expression.argumentExpression)
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const declaration = checker.getSymbolAtLocation(expression.name)?.valueDeclaration
      return declaration !== undefined && declaration.getSourceFile().isDeclarationFile
    }
    return false
  }
  const collectPassedArguments = (
    calls: readonly (ts.CallExpression | ts.NewExpression)[],
    declaration: ts.SignatureDeclaration,
    parameter: ts.ParameterDeclaration,
    index: number,
    excludeBackEdges: boolean,
    skipSilentSites: boolean
  ):
    | {
        readonly passed: readonly ts.Type[]
        readonly sawBackEdge: boolean
        readonly sawOmitted: boolean
        readonly sawSilentSite: boolean
        readonly deferredRecursiveArguments: readonly ts.Expression[]
      }
    | { readonly refused: string } => {
    const passed: ts.Type[] = []
    const deferredRecursiveArguments: ts.Expression[] = []
    let sawBackEdge = false
    let sawOmitted = false
    let sawSilentSite = false
    const record = (argument: ts.Expression): void => {
      const known = argumentsByParameter.get(parameter)
      if (known === undefined) argumentsByParameter.set(parameter, new Set([argument]))
      else known.add(argument)
    }
    for (const call of calls) {
      const effectiveArguments = invocationOperands.get(call)!.args
      // `describe( ...args )` where `args` is a rest parameter DECLARED as a
      // closed tuple hands this position exactly the tuple's element there.
      // `producers/tuple-spread.ts` expands that spread into constant-index
      // reads typed by the same declaration; read the same fact here, or the
      // operands say `number` while this formal's storage is refused
      // `argument-unresolved` on the spread node and boxed -- which is how
      // `x * y` in a forwarding callee became a dynamic multiplication with
      // no C++ spelling (test/runtime/tuple-typed-rest-spread.runtime.js).
      // A position past the tuple's arity is a genuinely omitted argument,
      // and falls through to the omission rule below like any other.
      const forwarded = declaredTupleSpreadPositionAt(checker, effectiveArguments, index)
      if (forwarded !== null) {
        passed.push(forwarded.isLiteral() ? checker.getBaseTypeOfLiteralType(forwarded) : forwarded)
        continue
      }
      const argument = effectiveArguments[index]
      // The checker also authenticates JSDoc's `[name]` as optional. Looking
      // only for a question token rejected legal JS constructor omissions and
      // discarded all their supplied configuration evidence. Absence is a
      // real incoming value, including when every caller omits the argument;
      // only a default replaces it before the body observes the binding.
      if (!argument && checker.isOptionalParameter(parameter)) {
        sawOmitted = true
        if (parameter.initializer === undefined) passed.push(checker.getUndefinedType())
        continue
      }
      if (!argument) return { refused: 'call-passes-no-argument' }
      // A BACK EDGE, not a second opinion. `projectObject( children[ i ],
      // camera, groupOrder, sortObjects )`, called from inside `projectObject`
      // itself, hands `groupOrder` its OWN value right back unchanged --
      // carrying no information about what the parameter holds until the
      // parameter is already bound. Joining it as if it were a disagreeing
      // call site is a category error: it is the recursion's own back edge.
      //
      // Excluding it is sound because it is VERIFIED, not assumed: the
      // structural test below (`referencesParameter`) is the same test that
      // finds it, and it proves the excluded argument literally IS
      // `parameter` -- so whatever `parameter` ends up bound to from the
      // OTHER call sites, this call site passes exactly that value BY
      // CONSTRUCTION. There is no type this argument could independently
      // hold that would disagree; a bare re-read of the same storage cannot
      // diverge from what that storage is bound to. That is a stronger
      // guarantee than re-resolving the argument after binding would give,
      // and it is available now, in the same round, without reopening the
      // fixpoint.
      const recursiveWithin = isRecursiveCallWithin(call, declaration)
      const isIdentityBackEdge = recursiveWithin && referencesParameter(argument, parameter)
      const isDerivedBackEdge = recursiveWithin && !isIdentityBackEdge && isDerivedFromParameter(argument, parameter)
      const isBackEdge = isIdentityBackEdge || isDerivedBackEdge
      if (isBackEdge) sawBackEdge = true
      if (isDerivedBackEdge) deferredRecursiveArguments.push(argument)
      if (excludeBackEdges && isBackEdge) continue
      const resolved = propagating.known(argument) ?? propagating.resolve(argument)
      if (!resolved || isUnusableEvidence(resolved)) {
        // A default is not an annotation. If this read still has the checker's
        // dynamic type, it is a possible supplied value, not an omitted call.
        // Publish that actual type beside the initializer so falling back to
        // the checker's default-only parameter type cannot erase the input.
        const supplied = checker.getTypeAtLocation(argument)
        if (parameter.initializer && (supplied.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
          passed.push(supplied)
          record(argument)
          continue
        }
        if (skipSilentSites && !resolved && isSuppliedDynamic(argument)) {
          passed.push(supplied)
          record(argument)
          continue
        }
        // An explicit unresolved argument is not an omitted argument. A
        // default describes only omission/undefined, so it cannot prove a
        // carrier for an unknown supplied value. Likewise void/never is a
        // real refusal, never evidence that the call did not happen.
        if (resolved || !skipSilentSites || parameter.initializer !== undefined) {
          return { refused: resolved ? 'argument-states-no-storage' : 'argument-unresolved' }
        }
        sawSilentSite = true
        continue
      }
      // `f(5)` does not mean the parameter holds only `5`. A literal argument's
      // type is a fact about the call, not about the storage it lands in, and a
      // second call site passing `6` would then read as a disagreement.
      passed.push(resolved.isLiteral() ? checker.getBaseTypeOfLiteralType(resolved) : resolved)
      record(argument)
    }
    return { passed, sawBackEdge, sawOmitted, sawSilentSite, deferredRecursiveArguments }
  }

  /** The type every call site passes at this position, or the reason there is no single one. */
  const agreedArgumentType = (
    declaration: ts.SignatureDeclaration,
    parameter: ts.ParameterDeclaration,
    parameterIndex: number,
    skipSilentSites: boolean
  ):
    | { readonly type: ts.Type; readonly sawSilentSite: boolean; readonly deferredRecursiveArguments: readonly ts.Expression[] }
    | {
        readonly unionArms: readonly ts.Type[]
        readonly sawSilentSite: boolean
        readonly deferredRecursiveArguments: readonly ts.Expression[]
      }
    | { readonly refused: string } => {
    const calls = callsByDeclaration.get(declaration) ?? []
    const contracts = contractsFor(declaration) ?? []
    const contractTypes: ts.Type[] = []
    for (const contract of contracts) {
      const type = callbackContractParameterType(checker, contract, parameterIndex)
      if (!type) return { refused: 'callback-contract-has-no-parameter' }
      contractTypes.push(type)
    }
    if (calls.length === 0 && contractTypes.length === 0) return { refused: 'no-call-site' }
    // A typed boundary must not turn a partially observed direct caller set
    // into a closed one. Unresolved direct inputs remain a refusal here.
    const allowSilentDirectSites = skipSilentSites && contracts.length === 0
    const excluding = collectPassedArguments(calls, declaration, parameter, parameterIndex, true, allowSilentDirectSites)
    if ('refused' in excluding) return excluding
    // A back edge is worth excluding only where doing so buys something:
    // real, independent evidence survives once it is set aside. Where the
    // back edge IS the only evidence -- `excluding.passed` comes back empty
    // -- there is nothing left to improve on, and refusing here would make
    // a parameter the OLD, pre-exclusion join could still answer WORSE than
    // before this exclusion existed: measured on the three.js app, paying the
    // exclusion unconditionally cost +6002 boxed carriers (+21%) for +14
    // resolved rows elsewhere, because most exclusions landed exactly here,
    // on parameters recursion-only in this program. Fall back to the
    // previous reading instead: join every call site, back edge included.
    // The same soundness argument above still covers it -- a bare re-read
    // of the parameter's own storage cannot disagree with whatever that
    // storage is bound to -- so including it here adds no unsound
    // information; it just declines to improve on the declaration the way
    // excluding it would have.
    const resolution =
      excluding.passed.length > 0 || !excluding.sawBackEdge
        ? excluding
        : collectPassedArguments(calls, declaration, parameter, parameterIndex, false, allowSilentDirectSites)
    if ('refused' in resolution) return resolution
    // Reachable for a second reason once silent sites are dropped: every site
    // was silent -- no evidence at all, named for what actually happened.
    // Named apart from the per-site refusal above for the same reason: this is
    // "every site was silent", the relaxed phase's own exhaustion, not one
    // site handing over an unusable type.
    // A call site that leaves a defaulted parameter out is a WRITE of the
    // initializer: it runs at that call, so its type joins the cell's writes
    // exactly as a passed argument would. `static #m([x] = [1])` reached only
    // as `C.method()` is the all-silent shape (refusing it left the pattern
    // reading a dynamic array); `f([3])` beside `f()` is the mixed one, where
    // dropping `[1]` from the join had the pattern read a position the
    // default never states.
    const defaulted =
      (resolution.passed.length === 0 || resolution.sawOmitted) && parameter.initializer
        ? (propagating.known(parameter.initializer) ?? propagating.resolve(parameter.initializer))
        : null
    // An evaluated `{}` default is the exact empty holder
    // (`exactEmptyObjectLiteralType`), not the vacuous annotation
    // `isUnusableEvidence` rightly drops: `function f({} = {})` reached only
    // as `f()` bound the parameter to `undefined` alone once its one real
    // write was filtered out. Taken only when no call site supplies a shape
    // of its own -- beside one, the join would let the empty literal (which
    // every object is assignable to) swallow the supplied shape, and the
    // pattern would read every key as absent.
    const emptyDefault =
      (resolution.passed.length === 0 || resolution.sawOmitted) &&
      parameter.initializer &&
      resolution.passed.every((type) => isNullishType(type))
        ? exactEmptyObjectLiteralType(checker, parameter.initializer)
        : null
    const directPassed =
      emptyDefault !== null
        ? [...resolution.passed, emptyDefault]
        : defaulted && !isUnusableEvidence(defaulted)
          ? [...resolution.passed, defaulted]
          : resolution.passed
    // Direct callers remain evidence even beside a typed higher-order slot.
    // In particular, an any input absorbs the typed contract rather than
    // letting the convenient boundary erase a real caller.
    // An assignment in the body writes this same cell, so its value joins the
    // incoming arguments before agreement is judged -- see the reassignment
    // note on `notReassigned`. An operator-typed write (`r *= a`) is read off
    // the assignment expression itself, where the operator states the result;
    // every other write is resolved like any other value expression.
    const parameterSymbol = ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined
    const writes = (parameterSymbol && assignedEvidence.get(parameterSymbol)) || []
    const writtenTypes = writes.map((write) =>
      write.operatorTyped
        ? checker.getTypeAtLocation(write.expression)
        : (propagating.known(write.expression) ?? propagating.resolve(write.expression))
    )
    // A complete numeric incoming frame can seed a numeric storage invariant.
    // Test EVERY write under that hypothesis before publishing it. In
    // particular, += is operand-sensitive: its checker answer stays any for an
    // unannotated self-read, although a numeric input and numeric RHS preserve
    // number. A string/opaque write, omitted unknown default or incomplete
    // caller must never borrow this seed to hide another possible value.
    const numeric = (type: ts.Type | null | undefined): type is ts.Type =>
      type !== null && type !== undefined && (type.flags & ts.TypeFlags.NumberLike) !== 0
    const incoming = [...directPassed, ...contractTypes]
    const numericSeed =
      incoming.length > 0 &&
      incoming.every(numeric) &&
      !resolution.sawSilentSite &&
      !resolution.sawBackEdge &&
      (index.implicitArgumentsUses.get(declaration)?.length ?? 0) === 0 &&
      resolution.deferredRecursiveArguments.length === 0 &&
      (!resolution.sawOmitted || numeric(defaulted))
    let invariantTypes: readonly (ts.Type | null | undefined)[] | null = null
    if (numericSeed && writtenTypes.some((type) => !type || isUnusableEvidence(type))) {
      const tentative = writes.map((write, position) => {
        const expression = write.expression
        if (!write.operatorTyped || !ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken)
          return writtenTypes[position]
        return derivedExpressionType(checker, expression, (operand) =>
          ts.isIdentifier(operand) && checker.getSymbolAtLocation(operand) === parameterSymbol
            ? checker.getNumberType()
            : (propagating.known(operand) ?? propagating.resolve(operand))
        )
      })
      if (tentative.every(numeric)) invariantTypes = tentative
    }
    const assignedTypes: ts.Type[] = []
    for (const written of invariantTypes ?? writtenTypes) {
      if (!written || isUnusableEvidence(written)) return { refused: 'parameter-reassigned' }
      assignedTypes.push(written)
    }
    const passed = [...directPassed, ...contractTypes, ...assignedTypes]
    if (passed.length === 0) return { refused: skipSilentSites ? 'every-call-site-silent' : 'no-call-site' }
    // Omission is a real write, but cannot seed a concrete carrier while
    // supplied arguments remain unresolved. Otherwise the relaxed sweep
    // seals an optional forwarding method to Undefined before its callers
    // settle, then inserts failing unboxes for their actual objects.
    if (resolution.sawSilentSite && passed.every(isNullishType)) return { refused: 'nullish-only-partial-evidence' }
    // A supplied dynamic value beside the default (`retain(); retain(JSON.
    // parse('{}'))`, `collectPassedArguments`'s own `supplied` arm) makes the
    // cell dynamic outright: `any` absorbs every other write, and asking
    // `joinOfWrites` to find a widest member among `[any, undefined]` only
    // refuses the site as a disagreement, erasing the input the arm kept.
    const dynamic = passed.find((type) => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
    if (dynamic)
      return { type: dynamic, sawSilentSite: resolution.sawSilentSite, deferredRecursiveArguments: resolution.deferredRecursiveArguments }
    const joined = joinOfWrites(checker, passed) // same write-set join a cell's writes get
    if (joined)
      return { type: joined, sawSilentSite: resolution.sawSilentSite, deferredRecursiveArguments: resolution.deferredRecursiveArguments }
    // No single covering type -- is the disagreement itself sound? See `disjointUnionMembersOf`.
    const arms = disjointUnionMembersOf(checker, passed)
    return arms
      ? { unionArms: arms, sawSilentSite: resolution.sawSilentSite, deferredRecursiveArguments: resolution.deferredRecursiveArguments }
      : { refused: 'call-sites-disagree' }
  }

  // A fixpoint, because an argument can itself be an unannotated parameter one
  // frame up: `WebGLRenderer`'s own `context` is bound from the application
  // before `WebGLTextures`'s `_gl` can be bound from `WebGLRenderer`. Rounds
  // stop when a pass adds nothing, which terminates because a binding is only
  // ever added and there are finitely many parameters.
  /**
   * Attribute every call to the declaration it reaches, using this round's
   * bindings where the checker had no answer.
   *
   * `getResolvedSignature` gives up on `extensions.has( ... )` while
   * `extensions` is `any`, and never revisits it -- so the functions three's
   * factories return as members of a record have, from the checker's view, no
   * callers at all. They have exactly one each, and it becomes visible the
   * moment the record has a type. That is why attribution belongs INSIDE the
   * fixpoint: a round that binds `extensions` is what lets the next round see
   * who calls its members.
   */

  /** Records `call` as a site of `declaration`, once -- the same call can arrive from two different attribution passes below and must not double-count. */
  const pushCall = (declaration: ts.Declaration, call: ts.CallExpression | ts.NewExpression): void => {
    if (
      isRealCallableDeclaration(declaration) &&
      !declaration.getSourceFile().isDeclarationFile &&
      'body' in declaration &&
      declaration.body
    ) {
      const targets = callTargets.get(call)
      if (!targets) callTargets.set(call, [declaration])
      else if (!targets.includes(declaration)) targets.push(declaration)
    }
    const existing = callsByDeclaration.get(declaration)
    if (existing) {
      if (!existing.includes(call)) existing.push(call)
    } else callsByDeclaration.set(declaration, [call])
  }

  /**
   * The selector declarations that could have produced the value now held by
   * `identifier`'s own storage -- `const setter = getSingularSetter(type);`
   * -- so that a later `setter( gl, v )` can be attributed to whatever that
   * selector returns, the same way `getSingularSetter(type)( gl, v )` (no
   * intervening variable) already is.
   *
   * Every WRITE to the identifier's binding is considered, same as
   * `writeSetTypeOf` considers every write to a cell: a write that is not
   * itself a call, or a call the checker did not attribute to a known
   * selector, simply contributes nothing here -- it is not a disagreement,
   * because this is gathering CALL-SITE evidence for whichever function
   * actually runs, not a claim about every value the variable could ever
   * hold. A write from an unrelated source and a write from a selector can
   * coexist on the same variable; the call site's arguments are the same
   * fixed expressions in the source regardless of which one is live, so
   * crediting the selector's returned functions with this call's evidence is
   * sound even when the other write cannot be explained.
   */
  const selectorsFeedingVariable = (identifier: ts.Identifier): ReadonlySet<ts.SignatureDeclaration> => {
    const symbol = checker.getSymbolAtLocation(identifier)
    const declarations = symbol?.declarations
    const declaration = declarations && declarations.length === 1 ? declarations[0] : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration)) return EMPTY_DECLARATIONS
    const writes = valueFlow
      .writesToDeclaration(declaration)
      .flatMap((write) => (write.slot === 'whole' && write.value !== null ? [write.value] : []))
    let result: Set<ts.SignatureDeclaration> | null = null
    for (const write of writes) {
      if (!ts.isCallExpression(write)) continue
      const selector = checkerAttribution.get(write)
      const returned = selector && aliasEvidence.returnedFrom.get(selector as ts.SignatureDeclaration)
      if (!returned) continue
      if (!result) result = new Set()
      for (const declaration of returned) result.add(declaration)
    }
    return result ?? EMPTY_DECLARATIONS
  }

  /**
   * Every declaration this ALIAS pass attributes `call` to, beyond whatever
   * the checker or the propagating resolver already found -- see
   * `AliasEvidence`. Both shapes are real, symbol-anchored evidence, not a
   * guess: a member call matches only when the checker resolves the SAME
   * member symbol something was published under, and a selector-result call
   * matches only when the checker (not this census) already attributed the
   * inner call producing that result. A dynamic receiver or an unresolved
   * intermediate resolves to no symbol at all, so neither branch fires and
   * the ordinary refusal stands, exactly as it did before this pass existed.
   */
  // Built on first use rather than up front: `closedArrayCalleeAuthorityOf`
  // composes three collection/protocol queries, and the vast majority of
  // programs never reach the element-callee branch that needs it at all.
  let heldArrayCalleeAuthority: CallableArrayOriginAuthority | null = null
  const arrayCalleeAuthority = (): CallableArrayOriginAuthority =>
    (heldArrayCalleeAuthority ??= closedArrayCalleeAuthorityOf(checker, valueFlow, propagatingTypeAt, implicitArgumentsUsesAt))

  const aliasDeclarationsFor = (call: ts.CallExpression): ReadonlySet<ts.SignatureDeclaration> => {
    let result: Set<ts.SignatureDeclaration> | null = null
    const add = (declarations: ReadonlySet<ts.SignatureDeclaration> | undefined): void => {
      if (!declarations || declarations.size === 0) return
      if (!result) result = new Set()
      for (const declaration of declarations) result.add(declaration)
    }
    const heldOperands = invocationOperands.get(call)!
    const heldCallee = heldOperands.callee
    // Once a `.call`/`.apply` reading is settled -- statically, by
    // `unwrapExplicitThisCall`, or by THIS round's own closed-array proof
    // below -- it must stay settled every later round. `heldOperands` already
    // carries the readback of whichever `censusExplicitThisAt` answer built
    // THIS round's flow index, but `aliasDeclarationsFor` only recognizes the
    // pending (still-`.call`-wrapped) SHAPE further down, not an already-
    // resolved one (`heldCallee` is `array[ i ]` itself by then, no `.call`
    // property access left to match) -- so without this, round N proves the
    // reading, round N+1's index carries it, round N+1's OWN alias pass finds
    // no pending shape left to re-derive it from, publishes no
    // `explicitThisAt` answer for this call, and round N+2 reverts to
    // unresolved. Republishing the settled reading here breaks that
    // oscillation.
    if (heldOperands.explicitThis)
      pendingExplicitThisReadings.set(call, { callee: heldOperands.callee, receiver: heldOperands.receiver, args: heldOperands.args })
    if (ts.isPropertyAccessExpression(heldCallee) || ts.isElementAccessExpression(heldCallee)) {
      const key = ts.isPropertyAccessExpression(heldCallee) ? heldCallee.name.text : literalMemberNameOf(heldCallee)
      const receiver = propagating.known(heldCallee.expression) ?? propagating.resolve(heldCallee.expression)
      const memberSymbol =
        checker.getSymbolAtLocation(ts.isPropertyAccessExpression(heldCallee) ? heldCallee.name : heldCallee) ??
        (receiver && key !== null ? checker.getPropertyOfType(checker.getApparentType(receiver), key) : undefined)
      add(memberSymbol ? publishedDeclarationsFor(memberSymbol) : undefined)
      // `array[ i ].call( this, event )` -- a computed element read with no
      // literal key names no symbol at all, so the lookup above finds nothing
      // and the call is attributed to no declaration. That is exactly how
      // three's `EventDispatcher.dispatchEvent` invokes EVERY listener, which
      // is why each `on*Dispose( event )` body sees an untyped `event` and
      // every object recovered from `event.target` boxes.
      //
      // `arrayCalleeAuthority().arrayElementTargetsOf` is the identical
      // closed-array proof that `flow/callable-reach.ts`'s own `.call`/
      // `.apply` branch already trusts for ESCAPE closure (`callableArray-
      // TargetsOf`, with a record/dictionary-storage fallback via
      // `arrayStoredValuesOf` for a plain-object listener map like three's
      // `EventDispatcher._listeners[ type ]`); asked here for TYPE
      // ATTRIBUTION instead, so a listener's declaration receives this call
      // site as real parameter evidence the same way an override receives a
      // base's calls. It returns null unless the array's whole allocation
      // and use graph is closed, so it can only ever add complete evidence,
      // never a guess.
      //
      // Gated on the ordinary lookup having found nothing, so no attribution
      // that already worked can change.
      if (!memberSymbol && ts.isElementAccessExpression(heldCallee)) {
        const targets = arrayCalleeAuthority().arrayElementTargetsOf?.(heldCallee)
        if (targets) add(new Set(targets))
      }
      // The actual `array[ i ].call( this, event )` spelling: `heldCallee` is
      // the WRAPPER property access (`.call`/`.apply` itself), not the array
      // element, because `unwrapExplicitThisCall` left it unresolved -- its
      // static gate needs the element's checker type to already carry a call
      // signature, and an untyped push (`listeners[ type ].push( listener )`
      // onto a field with no declared element type) never does. The same
      // closed-array proof above still answers "is every value this array
      // ever held a real function" without needing that type, so ask it of
      // the WRAPPED element (`heldCallee.expression`) instead of `heldCallee`
      // itself, and commit to the explicit-this reading -- `thisArg` and the
      // real arguments, not the array-element receiver and both raw operands
      // -- only once it holds. `pendingExplicitThisReadings` feeds NEXT
      // round's `indexValueFlow` (`censusExplicitThisAt`), so `site.operands`
      // itself carries the corrected frame everywhere it is read (argument
      // census, host-mutation census, target resolution alike) rather than
      // this proof living only here.
      if (
        !memberSymbol &&
        ts.isPropertyAccessExpression(heldCallee) &&
        (key === 'call' || key === 'apply') &&
        ts.isElementAccessExpression(heldCallee.expression)
      ) {
        const element = heldCallee.expression
        const targets = arrayCalleeAuthority().arrayElementTargetsOf?.(element)
        if (targets) {
          add(new Set(targets))
          if (key === 'call') {
            pendingExplicitThisReadings.set(call, { callee: element, receiver: call.arguments[0] ?? null, args: call.arguments.slice(1) })
          } else if (call.arguments.length === 2) {
            const argumentsArray = call.arguments[1]
            if (
              argumentsArray &&
              ts.isArrayLiteralExpression(argumentsArray) &&
              argumentsArray.elements.every((e) => !ts.isSpreadElement(e))
            )
              pendingExplicitThisReadings.set(call, {
                callee: element,
                receiver: call.arguments[0] ?? null,
                args: argumentsArray.elements
              })
          }
        }
      }
    }
    const callee = call.expression
    if (ts.isCallExpression(callee)) {
      const selector = checkerAttribution.get(callee)
      add(selector ? aliasEvidence.returnedFrom.get(selector as ts.SignatureDeclaration) : undefined)
    } else if (ts.isIdentifier(callee)) {
      add(selectorsFeedingVariable(callee))
    }
    return result ?? EMPTY_DECLARATIONS
  }

  const attributeCalls = (): void => {
    callbackContracts.clear()
    callsByDeclaration.clear()
    callTargets.clear()
    resolvedCallDeclarations.clear()
    for (const call of allCalls) {
      let declaration = checkerAttribution.get(call) ?? null
      if (!declaration) {
        const calleeExpression = invocationOperands.get(call)!.callee
        const callee = propagating.known(calleeExpression) ?? propagating.resolve(calleeExpression)
        if (callee) {
          // The same rule the return-type walk above states: a JavaScript
          // factory called with `new` declares no construct signature, and its
          // call signature is what says which function is being entered. Asked
          // the other way here -- not "what does it return" but "whose
          // parameters do these arguments land in" -- and answering it the
          // narrow way silently withheld every argument written at a `new`
          // against a plain function, so those parameters saw no evidence at
          // all and stayed unannotated.
          const constructed = ts.isNewExpression(call) ? callee.getConstructSignatures() : []
          const signatures = constructed.length > 0 ? constructed : callee.getCallSignatures()
          if (signatures.length === 1) declaration = signatures[0]?.declaration ?? null
        }
      }
      if (declaration) {
        pushCall(declaration, call)
        if (ts.isFunctionLike(declaration)) resolvedCallDeclarations.set(call, declaration)
      }
      // ALIAS value flow: a call through a resolved member/selector-result
      // whose VALUE is a known function is a real call site of that
      // function too, in addition to (never instead of) whatever the block
      // above already attributed. Only `CallExpression`s are asked -- `new`
      // has no equivalent idiom in either shape.
      if (ts.isCallExpression(call)) {
        for (const aliased of aliasDeclarationsFor(call)) pushCall(aliased, call)
      }
    }
    // Close the declaration relation with a worklist. A single pass depends on
    // whether a base/override or sibling happened to be declared first, and can
    // omit transitive implementations from both parameter and effect edges.
    const pending = [...callsByDeclaration].flatMap(([declaration, calls]) => calls.map((call) => ({ declaration, call })))
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const { declaration, call } = pending[cursor]!
      const destinations = [...(overridesOfBaseMethod.get(declaration) ?? []), ...(siblingMemberDeclarations.get(declaration) ?? [])]
      for (const destination of destinations) {
        if (callsByDeclaration.get(destination)?.includes(call)) continue
        pushCall(destination, call)
        pending.push({ declaration: destination, call })
      }
    }
  }

  /**
   * A parameter as a refusal's `owner`: the enclosing callable's name (or its
   * syntax kind, for one `nameOfCallable` cannot name) beside the parameter's
   * own name and source position -- the same identifying triple
   * `debugReport` below already prints, so a refusal and the debug line name
   * the same parameter the same way.
   */
  const describeParameter = (parameter: ts.ParameterDeclaration): string => {
    const callableName = nameOfCallable(parameter.parent)?.getText()
    const parameterName = ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText()
    const file = parameter.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(parameter.getStart()).line + 1
    return `${callableName ?? `<${ts.SyntaxKind[parameter.parent.kind]}>`}(${parameterName}) @${file.fileName.split('/').pop()}:${line}`
  }

  /**
   * The stable cause behind a reason string, for the refusal's `key`.
   *
   * Every reason this census writes is already a fixed kebab-case string with
   * one exception: `escapeReason` appends the escaping reference's syntax
   * kind (`function-escapes:CallExpression`, `function-escapes:unnamed:Root`,
   * ...), which varies per site by construction. Collapsing that family to
   * one root is the same split every other reason already gets for free --
   * the kind stays in `reason`, where the prose is allowed to vary.
   */
  const rootOf = (reason: string): string => (reason.startsWith('function-escapes') ? 'function-escapes' : reason)

  const refusals: CensusRefusal[] = []
  const refuse = (reason: string, owner: string, detail = reason): void => {
    refusals.push(censusRefusal('parameter', rootOf(reason), detail, owner))
  }

  // The reassignment split is in the index: it asks the checker for a symbol
  // per candidate and the answer cannot change between rounds. Escape, by
  // contrast, IS re-tested every round -- it is stated against the calls
  // attributed so far, and those grow.
  const notReassigned = index.notReassigned
  for (const candidate of index.reassigned) refuse('parameter-reassigned', describeParameter(candidate.parameter))
  /** The subset of `bindings` that came from a STATED annotation -- see `statedTypeAt`. */
  const statedBindings = new Map<ts.ParameterDeclaration, ts.Type>()
  let lastRefusal = new Map<ts.ParameterDeclaration, string>()
  /**
   * An optional parameter with no default binds `T | undefined` in its body, whatever
   * the call sites agree on: the declaration says a caller may omit it, and the
   * body can observe that omission. `structural-parts.ts`'s `parameterOf`
   * publishes the SLOT of the same parameter with `optional: true` off the
   * same checker optionality fact (including JSDoc), so a binding published without the absence made the
   * two frames disagree ("parameter 2 is bound as `string` but the ABI
   * declares `optional(string,undefined)`") and the whole body refused to
   * project. A DEFAULTED parameter is deliberately left alone: its body binding
   * is the type with the default already applied, and
   * `producers/bindings.ts`'s `contributeDefaultedParameter` is the one place
   * that splits the raw slot (with the absence) from that binding.
   */
  const withDeclaredAbsence = (parameter: ts.ParameterDeclaration, type: ts.Type): ts.Type =>
    checker.isOptionalParameter(parameter) && parameter.initializer === undefined
      ? checker.getNullableType(type, ts.TypeFlags.Undefined)
      : type
  /**
   * The synthesized-union counterpart of `withDeclaredAbsence`.
   *
   * `agreedArgumentType` returns `unionArms` when call sites contribute
   * structurally distinct carriers that have no single checker `ts.Type`.
   * That path used to bypass declared optionality, so `p?: T` bound only the
   * present synthesized arms in the body while `parameterOf` independently
   * widened the callable slot to `present | undefined`. ABI projection then
   * correctly refused the two physical frames. Preserve the same declared
   * absence at the one root where the synthesized arms enter the census.
   */
  const withDeclaredAbsenceArms = (parameter: ts.ParameterDeclaration, arms: readonly ts.Type[]): readonly ts.Type[] => {
    if (!checker.isOptionalParameter(parameter) || parameter.initializer !== undefined) return arms
    const containsUndefined = (type: ts.Type): boolean =>
      (type.flags & ts.TypeFlags.Undefined) !== 0 || (type.isUnion() && type.types.some(containsUndefined))
    return arms.some(containsUndefined) ? arms : [...arms, checker.getUndefinedType()]
  }

  /**
   * Prove every derived recursive back edge against the type learned from
   * independent callers. The temporary binding is visible only to this
   * resolver invocation; it is removed before any other candidate can observe
   * it. A subtype is safe because the provisional parameter carrier already
   * admits every value of that subtype. Anything unresolved, dynamic, or wider
   * refuses the candidate instead of laundering a cycle into evidence.
   */
  const validateDeferredRecursiveArguments = (
    parameter: ts.ParameterDeclaration,
    provisional: ts.Type,
    argumentsToValidate: readonly ts.Expression[]
  ): string | null => {
    if (argumentsToValidate.length === 0) return null
    bindings.set(parameter, provisional)
    propagating.reset()
    try {
      for (const argument of argumentsToValidate) {
        const resolved = propagating.known(argument) ?? propagating.resolve(argument)
        if (!resolved) return 'recursive-derived-argument-unresolved'
        if (isUnusableEvidence(resolved)) return 'recursive-derived-argument-states-no-storage'
        const passed = resolved.isLiteral() ? checker.getBaseTypeOfLiteralType(resolved) : resolved
        if (!checker.isTypeAssignableTo(passed, provisional)) return 'recursive-derived-argument-disagrees'
      }
      return null
    } finally {
      bindings.delete(parameter)
      propagating.reset()
    }
  }

  /** One sweep over every still-unbound candidate, answering how many it bound. */
  const bindingSweep = (skipSilentSites: boolean): number => {
    propagating.reset()
    attributeCalls()
    // `hasClosedMemberCallableUses` (`flow/callable-reach.ts`) memoizes its
    // answer keyed in part by this RECEIVER-TYPE FUNCTION's own identity --
    // sound for a whole-program compile, where the authority never changes
    // mid-walk, but `bindingSweep` calls it up to 48 times against a GROWING
    // `bindings` map behind the SAME `propagatingTypeAt` closure. A member
    // whose closure needs another parameter's binding (`event` here) to
    // settle first got asked, refused, and cached BEFORE that binding
    // existed -- and the cache, keyed on an identity that never changes,
    // never asked again. `stored-listener-member-closure.test.ts`'s `draw`
    // parameter is the measured case: refused round 1 (before `event`
    // settled), then silently served that same stale refusal every round
    // after, with no new proof activity at all. A fresh function identity
    // each round costs nothing this proof does not already recompute WITHIN
    // a round (the cache still hits repeat asks inside one sweep) and makes
    // the next round's improved `bindings` visible instead of shadowed.
    memberClosureReceiverTypeAt = (expression: ts.Expression) => propagatingTypeAt(expression)
    lastRefusal = new Map<ts.ParameterDeclaration, string>()
    let added = 0
    for (const candidate of notReassigned) {
      if (bindings.has(candidate.parameter) || unionArms.has(candidate.parameter)) continue
      const inferCandidate = (): boolean => {
        const escaped = escapeReason(candidate.declaration)
        if (escaped) {
          lastRefusal.set(candidate.parameter, escaped)
          return false
        }
        // Narrowing a declared upper bound needs complete call-site evidence.
        // Partial inference may discover an unannotated cycle, but cannot prove
        // that a declared unknown/union excludes its unresolved incoming values.
        const answer = agreedArgumentType(
          candidate.declaration,
          candidate.parameter,
          candidate.index,
          skipSilentSites && candidate.stated === null
        )
        // A STATED candidate is held to its statement. The agreed type has to be
        // assignable to it (the floor -- a callable value the annotation forbids
        // is not what this parameter holds, whatever the call sites say) AND to
        // differ from it only where the annotation said nothing. A synthesized
        // disjoint union is refused outright: those arms are a member LIST this
        // census builds for `table.intern`, never a `ts.Type` the statement can
        // be tested against, so there is nothing to hold it to.
        if (candidate.stated) {
          if (!('type' in answer)) {
            lastRefusal.set(candidate.parameter, 'unionArms' in answer ? 'stated-parameter-synthesized-union' : answer.refused)
            return false
          }
          if (carriesUnsubstitutedGeneric(checker, answer.type)) {
            lastRefusal.set(candidate.parameter, 'stated-parameter-open-generic')
            return false
          }
          if (!checker.isTypeAssignableTo(answer.type, candidate.stated)) {
            lastRefusal.set(candidate.parameter, 'stated-parameter-argument-not-assignable')
            return false
          }
          if (!narrowsOnlyUnstatedPositions(checker, candidate.parameter, candidate.stated, answer.type)) {
            lastRefusal.set(candidate.parameter, 'stated-parameter-narrows-a-stated-position')
            return false
          }
          const narrowed = withDeclaredAbsence(candidate.parameter, answer.type)
          const recursiveRefusal = validateDeferredRecursiveArguments(candidate.parameter, narrowed, answer.deferredRecursiveArguments)
          if (recursiveRefusal) {
            lastRefusal.set(candidate.parameter, recursiveRefusal)
            return false
          }
          bindings.set(candidate.parameter, narrowed)
          statedBindings.set(candidate.parameter, narrowed)
          return true
        }
        if ('type' in answer) {
          const narrowed = withDeclaredAbsence(candidate.parameter, answer.type)
          const recursiveRefusal = validateDeferredRecursiveArguments(candidate.parameter, narrowed, answer.deferredRecursiveArguments)
          if (recursiveRefusal) {
            lastRefusal.set(candidate.parameter, recursiveRefusal)
            return false
          }
          bindings.set(candidate.parameter, narrowed)
        } else if ('unionArms' in answer) {
          if (answer.deferredRecursiveArguments.length > 0) {
            lastRefusal.set(candidate.parameter, 'recursive-derived-argument-synthesized-union')
            return false
          }
          unionArms.set(candidate.parameter, withDeclaredAbsenceArms(candidate.parameter, answer.unionArms))
        } else {
          lastRefusal.set(candidate.parameter, answer.refused)
          return false
        }
        return true
      }
      const captured = protocolLedger?.capture(inferCandidate) ?? { value: inferCandidate(), requirements: [] }
      if (captured.value) {
        protocolRequirements.set(candidate.parameter, captured.requirements)
        added += 1
      }
    }
    return added
  }
  // EVIDENCE EXHAUSTED.
  //
  // After strict inference stops adding bindings, unstated parameters may
  // join evidence from resolvable sites while skipping unresolved sites.
  // This relaxation cannot discard a resolved unusable type, narrow an
  // explicitly stated boundary, or let a default replace a supplied argument.
  // For defaulted parameters, an explicitly supplied any/unknown value remains
  // evidence with its actual checker type. Missing arguments still follow
  // the separate default/absence rules. All-silent evidence still refuses.
  //
  // The phases alternate, because a parameter bound from surviving evidence is
  // itself evidence: the strict fixpoint re-opens with the new bindings and
  // gets first refusal on all it can now type strictly. It stops when a relaxed
  // sweep adds nothing -- terminating because bindings are only ever added.
  for (let phase = 0; phase < 4; phase += 1) {
    for (let round = 0; round < 12; round += 1) if (bindingSweep(false) === 0) break
    if (bindingSweep(true) === 0) break
  }
  // Relaxed bindings seed cycles; they are not proof that a silent caller
  // cannot supply another shape. Seal the fixed point against EVERY incoming
  // argument, then withdraw dependent conclusions until the survivors are
  // closed. Without this check an unresolved forwarding parameter disappears
  // from its callee's evidence and an unrelated call dictates a wrong unbox.
  // Re-attribution and resolver caches must follow each withdrawal as well:
  // consumers inferred strictly can still depend on a provisional producer.
  //
  // ESCAPE is re-tested here too, not only inside `bindingSweep`, for a gap
  // measured on the three.js app's `WebGLCapabilities( gl, extensions, parameters,
  // utils )`: `gl` and `parameters` bind in an early sweep, while `extensions`
  // and `utils` each depend on a whole separate factory (`WebGLExtensions`,
  // `WebGLUtils`) resolving first and so are still unbound several sweeps
  // later. `escapeReason`'s export/import check (`isModuleExportedDeclaration`
  // + `inProgramImportReferencesOf`) is re-evaluated fresh every sweep and, by
  // the time `extensions`/`utils` finally have argument evidence, it has
  // started returning `function-escapes:exported` for `WebGLCapabilities`
  // itself -- confirmed against the real corpus (the app's actual refusal
  // list carries exactly this reason for both parameters). `bindingSweep`'s
  // per-candidate loop skips any parameter already in `bindings`, so
  // `gl`/`parameters` are never asked again and keep a binding taken before
  // the escape was visible -- while their siblings on the SAME declaration,
  // tested one sweep later, are correctly refused. Escape is a fact about the
  // DECLARATION, not about which of its parameters happened to resolve
  // first: if the function escapes, every one of its parameters is bound
  // from a caller set this census can no longer prove complete, `gl`/
  // `parameters` included, and a wrong type is worse than a boxed one (this
  // module's own charter, above). Withdrawing only the late arrivals leaves
  // the early ones silently unsound -- answered, never refused, and never
  // revisited.
  //
  // Only the export/import reasons are retested, not the full `escapeReason`
  // surface: the member-closure reasons (`function-escapes:
  // uncounted-member-reference`, `function-escapes:uncounted-reference`, and
  // the generic reference-walk fallback) read `propagating`/`calls` for
  // OTHER declarations reachable through the same receiver -- three's
  // `renderer` argument that Object3D's `add` walks through its own
  // `arguments` frame is exactly this shape, closed by `memberClosed`. Once
  // any sibling candidate in that same chain withdraws earlier in this same
  // pass, `propagating.reset()` (a few lines below) clears the cache
  // `memberClosed` reads, and re-asking the full escape question mid-pass
  // read a still-valid closure proof as open -- breaking
  // `arguments-frame-member-closure.test.ts`'s positive case and
  // `implicit-arguments-tuple.test.ts`'s "closed callers" case. The
  // export/import check has no such dependency: whether `WebGLCapabilities`
  // is reachable from outside the compiled program is a property of the
  // module graph, invariant to which of ITS OWN parameters is currently
  // bound. Re-running exactly that check, and no more, makes the one
  // measured gap retroactive without reopening the proof the loosening
  // above exists to protect.
  let withdrew: boolean
  do {
    withdrew = false
    propagating.reset()
    unionTypes.clear()
    patternReadTypes.clear()
    argumentsByParameter.clear()
    attributeCalls()
    for (const candidate of notReassigned) {
      const parameter = candidate.parameter
      if (!bindings.has(parameter) && !unionArms.has(parameter)) continue
      const escaped = escapeReason(candidate.declaration)
      if (escaped === 'function-escapes:exported' || escaped === 'function-escapes:uncounted-import') {
        bindings.delete(parameter)
        unionArms.delete(parameter)
        protocolRequirements.delete(parameter)
        unionTypes.clear()
        statedBindings.delete(parameter)
        argumentsByParameter.delete(parameter)
        lastRefusal.set(parameter, escaped)
        propagating.reset()
        withdrew = true
        continue
      }
      const published = parameterTypeOf(parameter)
      const answer = agreedArgumentType(candidate.declaration, parameter, candidate.index, true)
      let reason: string | null = null
      if ('refused' in answer) reason = answer.refused
      else if (answer.sawSilentSite) reason = 'argument-unresolved'
      else {
        const incoming = 'type' in answer ? [answer.type] : answer.unionArms
        const admits = (type: ts.Type): boolean =>
          published !== null &&
          ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 ||
            (published.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) &&
          checker.isTypeAssignableTo(type, published)
        if (!incoming.every(admits)) reason = 'call-sites-disagree'
        else {
          for (const argument of answer.deferredRecursiveArguments) {
            const resolved = propagating.known(argument) ?? propagating.resolve(argument)
            if (!resolved || isUnusableEvidence(resolved) || !admits(resolved)) {
              reason = 'recursive-derived-argument-disagrees'
              break
            }
          }
        }
      }
      if (reason === null) continue
      bindings.delete(parameter)
      unionArms.delete(parameter)
      protocolRequirements.delete(parameter)
      unionTypes.clear()
      statedBindings.delete(parameter)
      argumentsByParameter.delete(parameter)
      lastRefusal.set(parameter, reason)
      propagating.reset()
      withdrew = true
    }
  } while (withdrew)
  // A checker narrowing is evidence about the SAME parameter cell, not a
  // conversion request. Preserve every distinct concrete object kind the
  // checker exposes under a pure `[string]: any` upper bound, alongside the
  // dictionary arm used by unnarrowed reads. Preserve the complete finite
  // member set, as the ordinary synthesized-union path does.
  for (const candidate of notReassigned) {
    const upper = candidate.flowCarrierUpperBound
    if (!upper || !ts.isIdentifier(candidate.parameter.name)) continue
    const symbol = checker.getSymbolAtLocation(candidate.parameter.name)
    const references = symbol ? valueFlow.memberReferencesToSymbol(symbol) : []
    const narrowed: ts.Type[] = []
    for (const reference of references) {
      const type = checker.getTypeAtLocation(reference)
      if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) continue
      if (!isFlowContainerType(checker, reference, type)) continue
      if (!checker.isTypeAssignableTo(type, upper)) continue
      if (checker.isTypeAssignableTo(upper, type)) continue
      if (narrowed.some((seen) => checker.isTypeAssignableTo(type, seen) && checker.isTypeAssignableTo(seen, type))) continue
      narrowed.push(type)
    }
    // A call that explicitly crosses this boundary from `any` contributes a
    // real dynamic arm. Plain runtime objects must remain the boxes they are;
    // rebuilding them as dictionaries would change identity and lose
    // prototype/accessor behavior. Concrete Document/Array/Map callers keep
    // their native arms beside it.
    let dynamicCallArm: ts.Type | null = null
    for (const call of callsByDeclaration.get(candidate.declaration) ?? []) {
      const args = invocationOperands.get(call)!.args
      const argument = args?.[candidate.index]
      if (!argument) continue
      const passed = checker.getTypeAtLocation(argument)
      if ((passed.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
        dynamicCallArm = passed
        break
      }
    }
    const arms = [upper, ...narrowed, ...(dynamicCallArm ? [dynamicCallArm] : [])]
    if (arms.length === 1) continue
    // This late flow-container publication is a second synthesized-arm entry
    // point. It must preserve the same declared absence as the ordinary
    // `unionArms` path above; otherwise an optional open-document parameter
    // (BSON's `DBRef(..., fields?: Document)`) binds a required body union
    // while its callable slot remains optional.
    flowCarrierArms.set(candidate.parameter, withDeclaredAbsenceArms(candidate.parameter, arms))
    flowCarrierBounds.set(candidate.parameter, upper)
    // The union is the cell's placement. A same-annotation binding learned
    // from call sites would otherwise outrank it in `parameterOf`.
    bindings.delete(candidate.parameter)
    statedBindings.delete(candidate.parameter)
    lastRefusal.delete(candidate.parameter)
  }
  // A stated JS parameter the census does not infer can still be left out by
  // a caller: three's `colorBuffer.setClear( 0, 0, 0, 1 )` against the
  // overlay's `@param {boolean} premultipliedAlpha`. Its cell then holds the
  // statement plus `undefined` -- see `omitted-stated-parameter.ts`. Asked of
  // the settled attribution after every withdrawal, so no argument binding it
  // reads can still be taken back; the closure proof runs under the ledger
  // like any inference, and its obligations are kept with the binding.
  propagating.reset()
  // `GEA_STATED_OMISSION_OFF` keeps the arm without this rule runnable, the way `GEA_BAG_OFF` is.
  for (const site of process.env['GEA_STATED_OMISSION_OFF'] ? [] : index.omissionSites) {
    if (bindings.has(site.parameter) || unionArms.has(site.parameter)) continue
    const answer = statedParameterWithOmission(
      checker,
      site.stated,
      site.index,
      callsByDeclaration.get(site.declaration) ?? [],
      (call) => invocationOperands.get(call)!.args,
      (argument) => propagating.known(argument) ?? propagating.resolve(argument) ?? checker.getTypeAtLocation(argument)
    )
    if (answer === null) continue
    if ('refused' in answer) {
      lastRefusal.set(site.parameter, answer.refused)
      continue
    }
    // Deliberately NOT gated on `escapeReason`. A caller the census cannot see
    // is held to the statement whether or not this binds -- that is what the
    // parameter's carrier is when it stays unbound -- so it can only add
    // statement values to the cell, never take away the `undefined` a caller
    // the census DOES see provably passes. Refusing an open caller set left
    // the bare statement standing, which is the one answer known to be wrong.
    const closure = (): string | null => ((contractsFor(site.declaration)?.length ?? 0) > 0 ? 'stated-omission-callback-contract' : null)
    const captured = protocolLedger?.capture(closure) ?? { value: closure(), requirements: [] }
    if (captured.value !== null) {
      lastRefusal.set(site.parameter, captured.value)
      continue
    }
    bindings.set(site.parameter, answer.type)
    statedBindings.set(site.parameter, answer.type)
    protocolRequirements.set(site.parameter, captured.requirements)
    if (process.env['GEA_BINDING_DEBUG'])
      console.error(`[STATED-OMISSION] ${describeParameter(site.parameter)} :: ${checker.typeToString(answer.type)}`)
  }
  for (const [parameter, reason] of lastRefusal) refuse(reason, describeParameter(parameter))
  /**
   * A READ of a stated parameter answers the BODY's binding, not the slot's.
   *
   * The two differ by exactly the absence a DEFAULT exists to answer: the slot
   * carries `undefined` (`statedUpperBound` puts it there deliberately, so a
   * caller passing a possibly-absent value is not refused), and by the time
   * the body runs the initializer has replaced it, so the cell holds the
   * undefined-free type -- which is precisely what
   * `producers/bindings.ts`'s `contributeDefaultedParameter` builds as its
   * `bodyType`. Answering a read with the slot's union instead is a
   * cell-versus-read split: hono's `this.#matchResult = matchResult` had the
   * cell holding `Result<[H, RouterRoute]>` while the read of the very same
   * parameter published `Result<[H, RouterRoute]> | undefined`.
   *
   * An initializer that IS `undefined` replaces nothing and the body really
   * can observe one -- the same carve-out, for the same reason, that
   * `contributeDefaultedParameter` states at length. An OPTIONAL parameter
   * with no default keeps its absence too: nothing filled it in.
   */
  const bodyBindingOf = (declaration: ts.ParameterDeclaration, narrowed: ts.Type): ts.Type => {
    if (!declaration.initializer) return narrowed
    if ((checker.getTypeAtLocation(declaration.initializer).flags & ts.TypeFlags.Undefined) !== 0) return narrowed
    return withoutUndefinedMember(checker, narrowed)
  }

  // Publication reads a settled binding set, so its memo is built once, after
  // the fixpoint stops -- unlike the propagating one, which is thrown away
  // each round because the answers it caches are answers to a smaller view.
  publishing.reset()

  /** Answers for `statedTypeAt`, settled once the fixpoint above has stopped. */
  const statedTypes = new Map<ts.Node, ts.Type | null>()

  const computeStatedTypeAt = (node: ts.Node): ts.Type | null => {
    // A PRIOR ROUND's stated narrowings are forwarded, the same way `known`
    // above forwards `upstream.typeAt`: round two exists precisely so a
    // census that could not see round one's answers gets them, and a
    // narrowing this round did not make itself is still the settled fact
    // about that cell. Without this the FIELD census's narrowings (round
    // one, composed outside this census) were invisible to round two's
    // return census, which then typed a `return this.#field` from the
    // checker's un-narrowed annotation and split the two cells apart.
    //
    // This closure over `upstream` is the same chain the `upstream` parameter's
    // own doc above names: it is why the object this function returns keeps
    // every earlier round's `ValueFlowIndex` (and `source-value-session.ts`'s
    // ~1 GB solver session for it) reachable for the rest of the compile.
    const inherited = upstream.statedTypeAt(node)
    if (inherited) return inherited
    if (ts.isParameter(node)) return statedBindings.size === 0 ? null : (statedBindings.get(node) ?? null)
    if (!ts.isIdentifier(node)) return null
    // Both branches below need the identifier's parameter declaration and
    // nothing else, so the symbol is resolved ONCE. It used to be asked twice
    // -- and asked at all even when both maps were empty, which for a program
    // that states no narrowings is the entire cost for no possible answer.
    if (flowCarrierBounds.size === 0 && statedBindings.size === 0) return null
    const declarations = checker.getSymbolAtLocation(node)?.declarations
    if (!declarations) return null
    const parameter = declarations.find(ts.isParameter)
    // A user predicate may give an open dynamic dictionary a named-record
    // VIEW so its property reads become typed. That does not replace the
    // object with a record allocation: the same dictionary enters and
    // leaves the guarded branch. Keep the cell's physical upper-bound
    // carrier at the identifier; destructuring/property producers still
    // use the checker's narrowed member types for each value they extract.
    const upper = parameter ? flowCarrierBounds.get(parameter) : undefined
    if (upper) {
      const read = checker.getTypeAtLocation(node)
      const isProperNarrowing = checker.isTypeAssignableTo(read, upper) && !checker.isTypeAssignableTo(upper, read)
      if (isProperNarrowing && !isFlowContainerType(checker, node, read)) return upper
    }
    if (statedBindings.size === 0) return null
    for (const declaration of declarations) {
      if (!ts.isParameter(declaration)) continue
      const narrowed = statedBindings.get(declaration)
      if (narrowed) return bodyBindingOf(declaration, narrowed)
    }
    return null
  }

  // Implicit slots have an owning signature but no parameter declaration.
  // Reuse the settled call attribution and resolver; never start a second
  // call-site inventory or infer from only the successfully typed callers.
  const implicitTuples = new Map<ts.Node, ImplicitArgumentsTuple>()
  /** Refused frames, for `debugReport` to print the open use behind each. */
  const implicitRefusals = new Map<ts.SignatureDeclaration, string>()
  // A `spread` edge names the spread's SOURCE, which it reads in bulk and never stores into.
  const writeNames = new Set(valueFlow.allWrites.flatMap((write) => (write.naming && write.edge !== 'spread' ? [write.naming] : [])))
  if (process.env['GEA_IMPLICIT_FRAME_DEBUG']) console.error(`[IMPLICIT-FRAME] owners in index: ${index.implicitArgumentsUses.size}`)
  for (const [owner, uses] of index.implicitArgumentsUses) {
    const infer = (): ImplicitArgumentsInference => {
      const signature = checker.getSignatureFromDeclaration(owner)
      const slot = signature ? implicitArgumentsSlotOf(signature) : null
      if (!slot) return { refused: 'implicit-arguments-no-frame' }
      const escape = escapeReason(owner, true)
      if (escape) return { refused: escape }
      if (owner.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken))
        return { refused: 'implicit-arguments-non-simple-parameters' }
      if (
        owner.parameters.some((parameter) => {
          const symbol = checker.getSymbolAtLocation(parameter.name)
          return symbol !== undefined && index.assigned.has(symbol)
        })
      )
        return { refused: 'implicit-arguments-parameter-reassigned' }
      const usable = (type: ts.Type | null, node: ts.Node): type is ts.Type =>
        !!type && !isUnusableEvidence(type) && !annotationStatesNothing(checker, node, type)
      return inferImplicitArgumentsTuple({
        checker,
        owner,
        slot,
        uses,
        calls: callsByDeclaration.get(owner) ?? [],
        argumentsOf: (call) => invocationOperands.get(call)!.args,
        isWritten: (node) => writeNames.has(node),
        isRecursiveCall: (call) => isRecursiveCallWithin(call, owner),
        argumentTypeOf: (argument) => {
          const type = propagating.known(argument) ?? propagating.resolve(argument)
          return usable(type, argument) ? type : null
        },
        statedElements: owner.parameters.flatMap((parameter) => {
          const type = checker.getTypeAtLocation(parameter)
          return usable(type, parameter) ? [type] : []
        })
      })
    }
    const captured = protocolLedger?.capture(infer) ?? { value: infer(), requirements: [] }
    const answer = captured.value
    if ('tuple' in answer) {
      implicitTuples.set(owner, answer.tuple)
      protocolRequirements.set(owner, captured.requirements)
      // A SETTLED frame can still be settled on a type nothing can carry, and
      // that outcome has no refusal to read: the census records only the
      // frames it turned down, so a frame that joined to a union no consumer
      // can lower looks identical to one that joined to a class. The three.js app's
      // largest nested-dynamic group -- 1382 carriers, every `.add( ... )` in
      // the program -- is one such frame, and nothing printed it.
      if (process.env['GEA_IMPLICIT_FRAME_DEBUG']) {
        const file = owner.getSourceFile()
        const line = file.getLineAndCharacterOfPosition(owner.getStart()).line + 1
        const shape =
          answer.tuple.frame === 'array'
            ? `array element=${checker.typeToString(answer.tuple.element)}`
            : `tuple required=${answer.tuple.required} elements=[${answer.tuple.elements.map((element) => checker.typeToString(element)).join(', ')}]`
        console.error(
          `[IMPLICIT-FRAME] ${nameOfCallable(owner)?.getText() ?? '<anonymous>'} @${file.fileName.split('/').pop()}:${line} ${shape}`
        )
      }
    } else {
      const file = owner.getSourceFile()
      const line = file.getLineAndCharacterOfPosition(owner.getStart()).line + 1
      if (process.env['GEA_IMPLICIT_FRAME_DEBUG'])
        console.error(
          `[IMPLICIT-FRAME] REFUSED ${nameOfCallable(owner)?.getText() ?? '<anonymous>'} @${file.fileName.split('/').pop()}:${line} ${answer.refused}`
        )
      const evidence = answer.evidence
      const evidenceFile = evidence?.getSourceFile()
      const detail =
        evidence && evidenceFile
          ? `${answer.refused}: ${evidenceFile.fileName}:${evidenceFile.getLineAndCharacterOfPosition(evidence.getStart()).line + 1} ${evidence.getText().slice(0, 160)}`
          : answer.refused
      implicitRefusals.set(owner, answer.refused)
      refuse(
        answer.refused,
        `${nameOfCallable(owner)?.getText() ?? '<anonymous>'}(arguments) @${file.fileName.split('/').pop()}:${line}`,
        detail
      )
    }
  }

  /**
   * The element join `restElementTypeAt` publishes, per rest parameter.
   *
   * `ECMA-262 10.2.11` step 28 (`FunctionDeclarationInstantiation`) binds a
   * rest parameter to a fresh Array unconditionally, whatever arity each
   * caller uses -- so unlike an ordinary parameter there is no "position 0
   * disagrees with position 1" question to ask here: every argument at or
   * past the rest's own ordinal, at EVERY call, is one more member of the
   * SAME array, and this asks for the one type that join settles on.
   *
   * Built from `callsByDeclaration`/`propagating` exactly as the implicit-
   * arguments frame above is -- both read the settled call attribution this
   * census's own fixpoint already closed, and neither needs a fixpoint of
   * its own: a rest parameter's element can only be as good as the call
   * sites it is joined from, and nothing downstream of THIS census ever
   * feeds back into what a call site passes.
   *
   * Deliberately conservative, matching `collectPassedArguments`'s own
   * refusal philosophy: a spread argument anywhere in the tail, or any
   * argument this census cannot resolve to usable evidence, refuses the
   * WHOLE parameter rather than joining a partial view of what a caller
   * passes -- leaving the checker's own (dynamic) answer exactly as it was
   * before this existed.
   *
   * The call-site tail is not the only writer of this cell: three's
   * `utils.js` reassigns its own rest parameter outright --
   * `params = enhanceLogMessage( params )` inside `warn`/`error` -- and that
   * write replaces the SAME binding the tail above is joined into, not a
   * different question. `assignedEvidence` already carries it: the ordinary
   * sweep's own reassignment index (`indexParameterBindingProgram`, above)
   * walks `valueFlow.allWrites` by `ts.isParameter(declaration)` alone, never
   * filtering out a `dotDotDotToken` parameter, so a rest parameter's own
   * reassignment was captured from the start even though nothing read it
   * until now. `enhanceLogMessage` is declared `@returns {Array<any>}`, so
   * the honest join over BOTH sources is dynamic -- declining here, exactly
   * as the tail loop above declines on a spread or unusable argument, is
   * what keeps `warn`'s declaration and every one of its call sites agreeing
   * on the same (boxed) carrier instead of the census narrowing one end past
   * what the body's own write still produces.
   */
  const restElementTypes = new Map<ts.ParameterDeclaration, ts.Type>()
  for (const candidate of index.restParameterCandidates) {
    const calls = callsByDeclaration.get(candidate.declaration) ?? []
    if (calls.length === 0) continue
    const passed: ts.Type[] = []
    let refused = false
    for (const call of calls) {
      if (refused) break
      const effectiveArguments = invocationOperands.get(call)!.args
      for (const argument of (effectiveArguments ?? []).slice(candidate.index)) {
        if (ts.isSpreadElement(argument)) {
          refused = true
          break
        }
        const resolved = propagating.known(argument) ?? propagating.resolve(argument)
        if (!resolved || isUnusableEvidence(resolved)) {
          refused = true
          break
        }
        passed.push(resolved.isLiteral() ? checker.getBaseTypeOfLiteralType(resolved) : resolved)
      }
    }
    if (!refused) {
      const symbol = ts.isIdentifier(candidate.parameter.name) ? checker.getSymbolAtLocation(candidate.parameter.name) : undefined
      const writes = symbol ? assignedEvidence.get(symbol) : undefined
      if (writes === null) refused = true
      else
        for (const write of writes ?? []) {
          if (refused) break
          const written = write.operatorTyped
            ? checker.getTypeAtLocation(write.expression)
            : (propagating.known(write.expression) ?? propagating.resolve(write.expression))
          // The write replaces the WHOLE array, not one element -- read its
          // own element out through the numeric index signature (the same
          // primitive `indexedTypeOf` above uses for `array[i]`) before
          // joining it against the tail's per-element evidence, or a
          // reassignment to a plain `Array<any>` would join `string` against
          // the ARRAY type itself rather than against its `any` element.
          const element = written && checker.getIndexTypeOfType(checker.getNonNullableType(written), ts.IndexKind.Number)
          if (!element || carriesNoEvidence(element)) {
            refused = true
            break
          }
          passed.push(element.isLiteral() ? checker.getBaseTypeOfLiteralType(element) : element)
        }
    }
    if (refused || passed.length === 0) continue
    const joined = joinOfWrites(checker, passed)
    if (joined) restElementTypes.set(candidate.parameter, joined)
  }

  /**
   * A rest parameter whose body forwards its ENTIRE array on, via a bare
   * `...name` spread naming its own binding as a call's ONLY argument, hands
   * that same array to whatever the call resolves to. `warnOnce( ...params )`
   * calling `warn( ...params )` in three's `utils.js` is exactly this: the
   * array `warnOnce` narrowed to `string` from its own callers' tail is the
   * IDENTICAL array `warn` receives, and `warn`'s own reassignment above
   * already forces it dynamic. A forwarder narrower than what its own target
   * settles on is not a smaller carrier for the same value, it is a SECOND,
   * disagreeing carrier for it -- exactly the shape `representation/verify.ts`
   * refuses to certify (`array-object(string) -> array-object(dynamic)`, no
   * conversion installed, and none may be: a mutable `ArrayObject` recast at a
   * call argument is a recorded aliasing miscompile, not a fallback here).
   *
   * Folded in as a SECOND pass, after every candidate's own call-site/
   * reassignment evidence has already settled, so which rest parameter
   * happens to be declared first in the file never changes the answer -- the
   * forward is asked once the map already holds every candidate's own-
   * evidence verdict, never a partial one.
   *
   * One-directional on purpose: the target's settled element folds into the
   * forwarder, never the reverse. `warn`'s own element is decided entirely by
   * `warn`'s OWN callers and its OWN body -- `warnOnce` forwarding into it is
   * not evidence about what `warn` does with the array, only about what
   * `warnOnce` must agree to.
   */
  const restCandidateByDeclaration = new Map(index.restParameterCandidates.map((candidate) => [candidate.declaration, candidate]))
  const isWithin = (node: ts.Node, ancestor: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true
    return false
  }
  for (const candidate of index.restParameterCandidates) {
    const symbol = ts.isIdentifier(candidate.parameter.name) ? checker.getSymbolAtLocation(candidate.parameter.name) : undefined
    if (!symbol) continue
    for (const call of allCalls) {
      if (!isWithin(call, candidate.declaration)) continue
      const effectiveArguments = invocationOperands.get(call)!.args
      if (!effectiveArguments || effectiveArguments.length !== 1) continue
      const sole = effectiveArguments[0]!
      if (!ts.isSpreadElement(sole) || !ts.isIdentifier(sole.expression) || checker.getSymbolAtLocation(sole.expression) !== symbol)
        continue
      const resolvedTarget = resolvedCallDeclarations.get(call)
      const targetCandidate = resolvedTarget ? restCandidateByDeclaration.get(resolvedTarget as ts.SignatureDeclaration) : undefined
      if (!targetCandidate || targetCandidate.parameter === candidate.parameter) continue
      const targetJoined = restElementTypes.get(targetCandidate.parameter)
      const ownJoined = restElementTypes.get(candidate.parameter)
      if (!targetJoined) restElementTypes.delete(candidate.parameter)
      else if (!ownJoined) restElementTypes.set(candidate.parameter, targetJoined)
      else {
        const combined = joinOfWrites(checker, [ownJoined, targetJoined])
        if (combined) restElementTypes.set(candidate.parameter, combined)
        else restElementTypes.delete(candidate.parameter)
      }
    }
  }

  // Later composed censuses can retain earlier inferred facts. Their protocol
  // dependencies remain required while any dependent parameter facts survive.
  protocolLedger?.replace('parameter-bindings', [...upstreamProtocolRequirements, ...[...protocolRequirements.values()].flat()])
  // `typeAt`, `patternReadTypeAt` and `statedTypeAt` below are the only fields
  // here that are not plain Map lookups -- see the `upstream` parameter's own
  // doc for why: they close over `publishing`/`computeStatedTypeAt`, which
  // close over this round's `valueFlow` and the whole `upstream` argument, so
  // THIS returned object is what keeps every earlier round's `ValueFlowIndex`
  // (and its `source-value-session.ts` solver session) reachable once it
  // becomes the next round's `upstream` -- and, for the settling round, for
  // the rest of the compile. `implicitArgumentsTupleAt`, `restElementTypeAt`,
  // `callDeclarationAt`, `callTargetsAt` and `argumentsAt` name neither and
  // are the ones a caller can hold onto for free.
  return {
    implicitArgumentsTupleAt: (owner) => implicitTuples.get(owner) ?? null,
    restElementTypeAt: (parameter) => restElementTypes.get(parameter) ?? null,
    callDeclarationAt: (call) => resolvedCallDeclarations.get(call) ?? null,
    explicitThisAt: (call) => pendingExplicitThisReadings.get(call) ?? null,
    callTargetsAt: (call) => callTargets.get(call) ?? null,
    typeAt: (node) =>
      implicitArgumentsReadTypeAt(checker, node, (owner) => implicitTuples.get(owner) ?? null) ??
      (ts.isParameter(node) ? parameterTypeOf(node) : publishing.resolve(node)),
    argumentsAt: (parameter) => {
      const known = argumentsByParameter.get(parameter)
      return known === undefined || !bindings.has(parameter) ? null : [...known]
    },
    patternReadTypeAt: (element) => {
      publishing.resolve(element)
      return patternReadTypes.get(element) ?? null
    },
    statedTypeAt: (node) => {
      // Memoized, and safe to memoize only HERE: this is the published view,
      // returned after the fixpoint has stopped, so `statedBindings` and
      // `flowCarrierBounds` no longer change and the answer for a node is
      // settled. The propagating view deliberately keeps no memo, because its
      // answers are answers to a smaller set of bindings.
      //
      // It earns the memo: this was 23% of a 58s three.js compile. Every
      // identifier in the program reaches it, and the body below asks the
      // checker for a symbol -- the single most expensive thing this compiler
      // can ask -- once per call.
      const remembered = statedTypes.get(node)
      if (remembered !== undefined) return remembered
      const answer = computeStatedTypeAt(node)
      statedTypes.set(node, answer)
      return answer
    },
    // A parameter and every UNNARROWED read of it are one storage cell. A
    // narrowed read keeps the checker's concrete arm so ordinary union loads
    // can select it from the placement rather than replacing the narrowing
    // with the full union again.
    unionArmsAt: (node) => {
      const declaration = ts.isParameter(node)
        ? node
        : ts.isIdentifier(node)
          ? checker.getSymbolAtLocation(node)?.declarations?.find(ts.isParameter)
          : undefined
      if (declaration) {
        const arms = flowCarrierArms.get(declaration)
        const upper = flowCarrierBounds.get(declaration)
        if (arms && upper) {
          if (ts.isParameter(node)) return arms
          const read = checker.getTypeAtLocation(node)
          if (checker.isTypeAssignableTo(read, upper) && checker.isTypeAssignableTo(upper, read)) return arms
          // An optional parameter read still carries every physical object
          // arm; the checker's added nullish member only describes the
          // dynamic arm's possible absent state. Preserve the same placement
          // until control flow removes an actual container arm.
          const present = checker.getNonNullableType(read)
          if (checker.isTypeAssignableTo(present, upper) && checker.isTypeAssignableTo(upper, present)) return arms
          return null
        }
      }
      return synthesizedUnionArmsAt(checker, node, unionArms)
    },
    boundCount: bindings.size + unionArms.size + flowCarrierArms.size + implicitTuples.size,
    refusals,
    refusalOf: (parameter) => lastRefusal.get(parameter) ?? null,
    debugReport: () => {
      const describeOpen = (entry: { readonly reference: ts.Expression; readonly kind: string }): string => {
        const reference = entry.reference
        const file = reference.getSourceFile()
        const location = `${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(reference.getStart()).line + 1}`
        const parent = `${ts.SyntaxKind[reference.parent.kind]} ${reference.parent.getText().slice(0, 160)}`
        return `${entry.kind} ${reference.getText().slice(0, 120)} in ${parent} @${location}`
      }
      const row = (reason: string, subject: string, at: ts.Node, owner: ts.SignatureDeclaration): string => {
        const path = memberOpenUses.get(owner) ?? []
        const open = path[0]
        const context = open ? `; ${describeOpen(open)}` : ''
        const continuation = path
          .slice(1)
          .map((entry) => `    via ${describeOpen(entry)}`)
          .join('\n')
        const file = at.getSourceFile()
        return `  ${reason}  <-  ${subject} @${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(at.getStart()).line + 1}${context}${continuation ? `\n${continuation}` : ''}`
      }
      const parameters = [...lastRefusal].map(([parameter, reason]) =>
        row(reason, parameter.getText().slice(0, 80), parameter, parameter.parent)
      )
      const frames = [...implicitRefusals].map(([owner, reason]) =>
        row(reason, `${nameOfCallable(owner)?.getText() ?? '<anonymous>'}(arguments)`, owner, owner)
      )
      return [...parameters, ...frames].join('\n') + '\n'
    }
  }
}
