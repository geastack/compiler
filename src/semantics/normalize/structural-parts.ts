import { implicitArgumentsSlotOf } from './implicit-arguments.js'
import ts from 'typescript'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { emptyCollectionBindingCensus, type CollectionBindingCensus } from './collection-bindings.js'
import { bagReturnTypeOf, bagShapeTypeAt, emptyObjectBagCensus, type ObjectBagCensus } from './object-bag-bindings.js'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { SignatureParameter, SignatureShape, StructuralIndexShape, StructuralMember, TupleElement } from '../model/structural-types.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import {
  accessorPassthroughMemberTargetOf,
  emptyDeclaredMemberCensus,
  literalAccessorOf,
  physicalInitializerTypeOf,
  type DeclaredMemberCensus
} from './structural-declarations.js'
import {
  parameterSlotTypeOf,
  restParameterArrayTypeOf,
  restParameterUnionOfTuplesElementTypeOf,
  impliedPatternArrayElementAt
} from './parameter-slot.js'
import { isUnusableEvidence } from './derived-expression-type.js'
import { inferredArrayElementAt, inferredCollectionTypeArgumentsAt } from './structural-array-element.js'
import type { IdentityTable } from './identities.js'

/**
 * What a declaration's PARTS are, once the walk knows how to translate a type.
 *
 * A signature's parameters, a member's key and modifiers, an index signature's
 * key domain, a tuple's elements: each is read off the checker and rendered as
 * the shape model states it, and each does so by asking one collaborator --
 * `typeOf` -- for every type it meets. None of them decides identity, interns
 * anything, or knows about anchors or recursion; that is `structural.ts`'s job,
 * and keeping these here is what makes that visible.
 */
export interface StructuralPartsInput {
  readonly checker: ts.TypeChecker
  readonly identities: IdentityTable
  /**
   * Which accessor bodies back a member a DECLARED shape spells as data --
   * the other half of `literalAccessorOf`, which answers only for a literal
   * laid out as itself. See the census's own doc for why it is keyed on the
   * declared member's symbol and why a disagreement answers nothing.
   */
  readonly declaredMembers?: DeclaredMemberCensus
  /** The walk's own translation, so a part's types are interned exactly as any other type is. */
  readonly typeOf: (type: ts.Type) => StructuralTypeId
  /** A signature with no written `this` still has a receiver when its declaration implies one. */
  readonly implicitReceiverOf: (declaration: ts.SignatureDeclaration) => ts.Type | null
  /**
   * The member declaration an object literal's own method implements -- the
   * one the record FIELD's carrier is built from. `signatureOf` reads its
   * result for a literal method that annotates none; see the authority's own
   * doc in `structural-receiver.ts`.
   */
  readonly declaredMemberSignatureOf: (declaration: ts.MethodDeclaration, literal: ts.ObjectLiteralExpression) => ts.MethodSignature | null
  /** A member with no expressible key contributes nothing rather than an invented one. */
  readonly keyOfSymbol: (symbol: ts.Symbol) => StructuralMember['key'] | null
  /**
   * Wraps an already-interned element id in the `array` shape, without going
   * back through a `ts.Type` -- there is no `T[]` `ts.Type` to build one from
   * (`checker.createArrayType` is checker-internal; see
   * `structural-array-element.ts`'s header for the same constraint). Needed
   * for exactly one caller: an unannotated rest parameter's own SLOT, whose
   * only available type is `restParameterArrayTypeOf`'s already-widened
   * ELEMENT type (see that function's doc). `structural.ts`'s `typeAt`
   * performs this identical wrap for a body-side reference to the same
   * parameter; this is `table.intern` reaching `parameterOf` for the
   * signature-side reference so both wrap the same way.
   */
  readonly internArray: (element: StructuralTypeId) => StructuralTypeId
  /** The return census can publish disjoint alternatives without a public ts.Type. */
  readonly internUnion: (members: readonly StructuralTypeId[]) => StructuralTypeId
  /**
   * What an unannotated parameter is actually called with.
   *
   * The ABI reads this for the same reason the body does, and that is the whole
   * point of it being here: `projection/abi.ts` checks the frame the body binds
   * against the frame the signature declares, and those two come from different
   * places -- the body from `mapper.typeAt` on the parameter node, the signature
   * from this function. A census consulted by one and not the other produces
   * exactly the disagreement that projection reports: "parameter 0 is bound as
   * `class-ref(...)` but the ABI declares `dynamic(...)`". One census, both
   * ends, one answer.
   */
  readonly parameters?: ParameterBindingCensus
  /**
   * A structural answer for a parameter the census bound in checker-type
   * space when the checker's image is not the carrier: `structural.ts`'s
   * `prototypeObjectParameterTypeAt`. Asked FIRST, so a signature's ABI and
   * the body's own binding read the same carrier -- the two disagreeing is
   * exactly the "parameter N is bound as X but the ABI declares Y" refusal
   * `projection/abi.ts` raises.
   */
  readonly parameterOverrideAt?: (parameter: ts.ParameterDeclaration) => StructuralTypeId | null
  /**
   * The whole-program census of what K/(V) a bare `new Map()`/`new Set()`/
   * `new WeakMap()`/`new WeakSet()` allocation, its owning declaration, or a
   * later read actually stores (`collection-bindings.ts`).
   *
   * `memberOf` below needs this for the identical reason it needs `parameters`
   * above: a class field's checker type and a later READ of that field must
   * derive from the SAME census answer, or emission sees a field "stored as"
   * one keyed-collection carrier and a read "publishing" a different one --
   * exactly the disagreement `structural.ts`'s `typeAt`
   * (`inferredCollectionTypeArgumentsAt`, `structural-array-element.ts`)
   * already closed for every OTHER node shape that names this same field.
   * `private store = new Map(); ... this.store.set(k, v)` is the case: the
   * checker's own answer for `store`'s declaration is `Map<unknown, unknown>`
   * (nothing about a bare allocation lets it infer more), and that answer is
   * never flagged `isUnusableEvidence` below -- a Map is not `any`/`void`/
   * `never` -- so the existing `parameters` fallback is never even asked. A
   * defaulted keyed-collection needs its OWN check for the same reason
   * `isUnusableEvidence` exists at all: the checker's answer LOOKS usable
   * while carrying none of the information this program's own later writes
   * gave it.
   */
  readonly collections?: CollectionBindingCensus
  /**
   * The table `inferredCollectionTypeArgumentsAt` interns the narrowed
   * keyed-collection shape into -- see that function's own header
   * (`structural-array-element.ts`) for why it needs the table directly
   * rather than a narrower wrapper the way `internArray` is for `array`.
   */
  readonly table?: StructuralTypeTable
  /**
   * The object-bag census, for the one collection value slot
   * `collection-bindings.ts` cannot close on its own -- see
   * `boundValueTypeId` (`structural-array-element.ts`). Threaded here for the
   * same reason `collections` and `table` are: a field's member type and every
   * read of that field must come from ONE answer, and half of one derived
   * without the bag census is a second authority over the same storage.
   */
  readonly bags?: ObjectBagCensus
}

export interface StructuralParts {
  readonly signatureOf: (signature: ts.Signature, resultOverride?: ts.Type) => SignatureShape
  readonly memberOf: (symbol: ts.Symbol, location: ts.Node | null) => StructuralMember | null
  readonly indexesOf: (type: ts.Type) => readonly StructuralIndexShape[]
  readonly tupleElementsOf: (type: ts.TupleTypeReference) => readonly TupleElement[]
}

/**
 * Only the standard library's bind protocol describes a synthetic flattened
 * entry. Its instantiated A/B tuples name captured arguments and the native
 * bound wrapper's remaining scalar slots; they do not name a source body's
 * rest container. This also covers the callable type in bind's `this` slot.
 *
 * An ordinary declaration, including a generic or a callable type annotation,
 * keeps one rest parameter even when its tuple has a statically known length.
 * Tuple cardinality alone is never evidence for changing a physical ABI.
 */
const isBuiltinBindParameter = (declaration: ts.ParameterDeclaration): boolean => {
  if (!declaration.getSourceFile().hasNoDefaultLib) return false
  let owner: ts.Node | undefined = declaration.parent
  while (owner && !ts.isMethodSignature(owner)) owner = owner.parent
  return (
    owner !== undefined &&
    ts.isMethodSignature(owner) &&
    ts.isIdentifier(owner.name) &&
    owner.name.text === 'bind' &&
    ts.isInterfaceDeclaration(owner.parent) &&
    (owner.parent.name.text === 'CallableFunction' || owner.parent.name.text === 'NewableFunction')
  )
}

const closedRestTupleElementsAt = (
  checker: ts.TypeChecker,
  declaration: ts.ParameterDeclaration,
  declared: ts.Type
): readonly { readonly type: ts.Type; readonly optional: boolean }[] | null => {
  if (declaration.dotDotDotToken === undefined || declaration.type === undefined || !isBuiltinBindParameter(declaration)) return null
  if (!checker.isTupleType(declared)) return null
  const reference = declared as ts.TupleTypeReference
  const target = reference.target
  const elements = checker.getTypeArguments(reference)
  const flagsAt = (index: number): ts.ElementFlags => target.elementFlags[index] ?? ts.ElementFlags.Required
  if (elements.some((_, index) => (flagsAt(index) & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0)) return null
  return elements.map((element, index) => ({ type: element, optional: (flagsAt(index) & ts.ElementFlags.Optional) !== 0 }))
}

/**
 * A type the checker INVENTED for an object literal, as opposed to one the
 * program named. Anonymous alone is not enough -- a type alias to a type
 * literal is anonymous too, and it IS a name the program wrote -- so the
 * literal's own declaration is what identifies it.
 */
const inferredObjectLiteralType = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false
  if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) === 0) return false
  return (type.symbol?.declarations ?? []).some(ts.isObjectLiteralExpression)
}

/** `GEA_MEMBER_DEBUG=<member>` reports which of the three sources answered that one member. */
const memberDebug = process.env['GEA_MEMBER_DEBUG']

export const createStructuralParts = (input: StructuralPartsInput): StructuralParts => {
  const { checker, identities, typeOf, implicitReceiverOf, declaredMemberSignatureOf, keyOfSymbol, internArray } = input
  const declaredMembers = input.declaredMembers ?? emptyDeclaredMemberCensus
  const parameters = input.parameters ?? emptyParameterBindingCensus
  const collections = input.collections ?? emptyCollectionBindingCensus
  const table = input.table ?? null
  const bags = input.bags ?? emptyObjectBagCensus

  const minimumArityOf = (signature: ts.Signature): number => {
    const parameters = signature.getParameters()
    let required = 0
    for (const parameter of parameters) {
      const declaration = identities.declarationOfSymbol(parameter)
      if (!declaration || !ts.isParameter(declaration)) break
      if (checker.isOptionalParameter(declaration) || declaration.dotDotDotToken) break
      required += 1
    }
    return required
  }

  /**
   * The type of a symbol, asked at a declaration when it has one.
   *
   * A signature's parameter symbol does not always have a declaration: an
   * *inferred* signature -- what JavaScript sources reach the checker as, and
   * what a union or instantiation of signatures synthesizes -- carries parameter
   * symbols the checker minted rather than parsed. There is no node to ask at,
   * and there used to be no answer for that: the symbol itself was cast to a
   * node and handed to `getTypeOfSymbolAtLocation`, which reads `location.parent`
   * and crashed inside TypeScript on `Cannot read properties of undefined
   * (reading 'kind')`. Every candidate whose type reached one of those
   * signatures was blocked by a producer failure -- 496 of the three.js app's, 392 of
   * three-angle-metal's -- because three.js is compiled from source and its
   * signatures are inferred, not declared.
   *
   * `getTypeOfSymbol` is the location-free form of the same question and the
   * right one to ask when there is no location; `structural-indexed-access.ts`
   * already asks it that way. The located form stays wherever a declaration
   * exists, because a location is what resolves a `this` type and narrows a
   * parameter to the site being asked about.
   *
   * Deliberately checker-only, not routed through `censusedTypeAt`: this asks
   * about a SYMBOL, not a node, and every real call site already gates its use
   * behind a census check of its own (`parameterOf`'s `bound = ... parameters.
   * typeAt(declaration)`, `memberOf`'s `fromCensus`/`censusResult` above) --
   * this is the shared fallback primitive those sites reach for only once the
   * census has already had, and declined, first say.
   */
  const typeOfSymbolAt = (symbol: ts.Symbol, location: ts.Node | undefined): ts.Type =>
    location ? checker.getTypeOfSymbolAtLocation(symbol, location) : checker.getTypeOfSymbol(symbol)

  /**
   * `parameterOf` for exactly one element of a rest parameter's
   * INSTANTIATED type, once `closedRestTupleElementsAt` (below) has already
   * proved that instantiation is a settled, closed tuple rather than an open
   * array -- `signatureOf`'s expansion caller, never `parameterOf` itself,
   * decides WHEN this applies.
   *
   * Deliberately bypasses every declaration-derived branch `parameterOf`
   * otherwise walks (the census, `restParameterArrayTypeOf`, the phantom/
   * union-of-tuples widenings): those all answer "what does the WHOLE rest
   * parameter hold", and a closed tuple's Nth element is a plain, ordinary
   * slot with its own settled type -- exactly the fact `tupleElementsOf`
   * already publishes for a tuple met anywhere else in this module. The one
   * piece still shared with an ordinary parameter is the absence widening
   * (`parameterSlotTypeOf`): an optional trailing tuple element still has to
   * hold `undefined` when the call omits it.
   */
  const parameterOfTupleElement = (element: { readonly type: ts.Type; readonly optional: boolean }): SignatureParameter => {
    const flags = { optional: element.optional, rest: false, hasInitializer: false }
    const type = typeOf(element.type)
    return { type, slot: parameterSlotTypeOf(input.internUnion, typeOf(checker.getUndefinedType()), flags, type), ...flags }
  }

  const parameterOf = (parameter: ts.Symbol, forceRest = false): SignatureParameter => {
    const declaration = identities.declarationOfSymbol(parameter)
    const isParameter = declaration !== null && ts.isParameter(declaration)
    const bound = isParameter ? parameters.typeAt(declaration) : null
    const boundArms = isParameter ? parameters.unionArmsAt(declaration) : null
    // The published ABI and the body it wraps read the SAME rest parameter --
    // see `parameter-slot.ts`'s `restParameterArrayTypeOf`, which the body's
    // own binding (`structural.ts`'s `typeAt`) already consults. Asked here,
    // ahead of the raw checker fallback, so a rest parameter's SLOT never
    // publishes the closed tuple the body itself was never bound to.
    //
    // `restParameterArrayTypeOf` returns the tuple's widened ELEMENT type --
    // its own doc says so ("The array's element type is `widestOf` ...") --
    // not the array. `structural.ts`'s `typeAt` (the body-side reference to
    // this same parameter) already wraps that element into an `array` shape
    // rather than publishing it bare; this is that same wrap, so the
    // signature's declared parameter type and the body's own binding of it
    // agree, and `derive.ts`'s `abiOf` -- which trusts a rest parameter's
    // slot is already the Array the language binds it to -- finds one there.
    const restArray = isParameter ? restParameterArrayTypeOf(checker, declaration) : null
    // Real call-site evidence for an UNANNOTATED rest parameter --
    // `parameter-bindings.ts`'s `restElementTypeAt`, joined over every
    // reachable caller's actual arguments at or past this parameter's own
    // ordinal -- outranks `restArray`'s bare checker-tuple widening exactly
    // as `bound` already outranks it for the reasons stated below: it is a
    // fact about what callers actually pass, not a guess reconstructed from
    // a contextual type. Gated to `bound === null` because a rest parameter
    // is never itself a `bound` candidate (`isUnannotated` refuses it, see
    // that function's own doc), so this is the one real "the census bound
    // this rest parameter" answer that exists.
    const censusRestElement =
      isParameter && declaration.dotDotDotToken !== undefined && bound === null
        ? (parameters.restElementTypeAt?.(declaration) ?? null)
        : null
    const declared = bound ?? typeOfSymbolAt(parameter, declaration ?? parameter.valueDeclaration)
    const flags = {
      optional: isParameter ? checker.isOptionalParameter(declaration) && declaration.initializer === undefined : false,
      rest: forceRest || (isParameter ? declaration.dotDotDotToken !== undefined : false),
      hasInitializer: isParameter ? declaration.initializer !== undefined : false
    }
    // `bound` (the parameter binding census) outranks `restArray` exactly as
    // it did before this wrap existed -- when the census has already bound
    // this declaration, that answer is shared with the body and is never the
    // bare tuple-derived element `restParameterArrayTypeOf` produces.
    //
    // A THIRD rest-parameter shape neither of the two branches above covers:
    // `...args: any`, an EXPLICIT annotation, so `restParameterArrayTypeOf`
    // (gated to `declaration.type === undefined`) never runs, and `bound`
    // has nothing published for a declaration this census does not bind.
    // `declared` is then the checker's own answer at the parameter symbol --
    // and for a rest parameter TypeScript lets the program spell `any`
    // instead of `any[]`, the checker reports the symbol's type back exactly
    // as written: bare `any`, never wrapped in an array. `abi.ts`'s
    // `derive.ts` (`abiOf`) has one primitive for a rest slot, `array`, so a
    // bare `any` reaching it derives to plain `dynamic` and every call that
    // spreads a real array into it refuses to pack -- hono's `mount()`
    // (`hono-base.ts`) forwards `...getOptions(c)`, a genuine `unknown[]`,
    // into `applicationHandler: (request, ...args: any) => ...` this exact
    // way. A rest parameter is ALWAYS the array ECMAScript's own
    // `FunctionDeclarationInstantiation` binds it to (see this file's
    // `parameterSlotTypeOf` sibling comment for the identical fact about the
    // UNANNOTATED case) -- an explicit `any` describes the ELEMENT the
    // program declined to narrow, never the container, so it is wrapped
    // rather than left bare: `array<dynamic>` is what the value physically
    // is, and boxing the whole parameter to avoid saying so is the same
    // shortcut CLAUDE.md's carve-out never licenses for a container.
    // A THIRD form an EXPLICITLY ANNOTATED rest parameter takes, alongside the
    // bare-`any` fallback below: a union of tuples -- `...args: [] | [TNext]`,
    // `lib.es2015.generator.d.ts`'s own spelling of `Generator.next`'s "zero or
    // one argument". `restArray` above never fires here (it is gated to the
    // UNANNOTATED case), and neither `checker.isArrayType` nor
    // `checker.isTupleType` is true of the union itself, so without this the
    // program falls straight into `restNotArrayShaped` and wraps the WHOLE
    // union as if it were one element -- see
    // `parameter-slot.ts`'s `restParameterUnionOfTuplesElementTypeOf` for the
    // emission refusal that produces.
    const restUnionOfTuples =
      isParameter && flags.rest && bound === null ? restParameterUnionOfTuplesElementTypeOf(checker, declared) : null
    // A constrained type parameter already denotes its container. `typeOf`
    // follows that constraint for the body's binding too; wrapping T again
    // here would publish Array<Array<number>> for T extends [number, number].
    const restContainer = flags.rest ? (checker.getBaseConstraintOfType(declared) ?? declared) : declared
    const restNotArrayShaped =
      flags.rest &&
      bound === null &&
      restArray === null &&
      restUnionOfTuples === null &&
      !checker.isArrayType(restContainer) &&
      !checker.isTupleType(restContainer)
    // The destructured-parameter twin of the rest wrap below -- one function
    // (`impliedPatternArrayElementAt`) answers it for the body's own binding
    // (`structural.ts`'s `typeAt`) and for this slot, so the two agree.
    const impliedElement = isParameter ? impliedPatternArrayElementAt(checker, parameters, declaration) : null
    const overridden = isParameter
      ? (input.parameterOverrideAt?.(declaration) ?? (table ? bagShapeTypeAt(table, typeOf, bags, declaration) : null))
      : null
    const type = overridden
      ? overridden
      : impliedElement
        ? internArray(typeOf(impliedElement))
        : boundArms
          ? input.internUnion(boundArms.map(typeOf))
          : censusRestElement !== null
            ? internArray(typeOf(censusRestElement))
            : bound === null && restUnionOfTuples !== null
              ? internArray(typeOf(restUnionOfTuples))
              : bound === null && restArray !== null
                ? internArray(typeOf(restArray))
                : restNotArrayShaped
                  ? internArray(typeOf(declared))
                  : typeOf(declared)
    // The slot widens the SAME type the body binds -- the census's answer when
    // it has one, the checker's otherwise -- for the reason stated on the
    // `parameters` field above: one census, both ends, one answer.
    return { type, slot: parameterSlotTypeOf(input.internUnion, typeOf(checker.getUndefinedType()), flags, type), ...flags }
  }

  /**
   * `resultOverride` is how an optional call's callee gets the return its method
   * actually has: the checker's resolved signature carries the chain's added
   * `undefined`, which is a fact about the call expression and not about the
   * function being called (`producers/optional-chain.ts`).
   */
  const signatureOf = (signature: ts.Signature, resultOverride?: ts.Type): SignatureShape => {
    const thisParameter = signature.thisParameter
    const written = thisParameter ? typeOfSymbolAt(thisParameter, thisParameter.valueDeclaration) : null
    const declaration = signature.getDeclaration()
    const receiver = written ?? (declaration ? implicitReceiverOf(declaration) : null)
    // The checker gives a union call signature its first declaration, but that
    // declaration does not own every possible method receiver. Preserve the
    // component receivers before publishing one physical callable convention.
    // An explicit `this` remains the checker's own resolved constraint.
    const composite = signature as ts.Signature & {
      readonly compositeKind?: ts.TypeFlags
      readonly compositeSignatures?: readonly ts.Signature[]
    }
    const implicitReceivers =
      written === null && composite.compositeKind === ts.TypeFlags.Union
        ? (composite.compositeSignatures ?? []).flatMap((part) => {
            const own = part.getDeclaration()
            const implicit = own ? implicitReceiverOf(own) : null
            return implicit ? [typeOf(implicit)] : []
          })
        : []
    const receiverType = implicitReceivers.length > 0 ? input.internUnion(implicitReceivers) : receiver ? typeOf(receiver) : null
    // The return census (`return-bindings.ts`, composed into `parameters` by
    // `withReturnBindings`/`composeReturnBindings` -- see this file's own
    // `parameters` field doc) answers exactly this question for a function
    // DECLARATION, not only for a call site: `ReturnBindingCensus.typeAt`
    // special-cases `isReturnCandidateKind(node)` to return its own bound
    // answer straight from the declaration. `parameterOf` above already asks
    // the same composed census for every parameter (`parameters.typeAt(declaration)`);
    // the result was the one slot of a signature that never asked at all --
    // reaching for the checker's raw, un-narrowed `signature.getReturnType()`
    // even where the census had already resolved the join of the function's
    // own `return` statements. That is the two-authorities defect this module's
    // header describes for parameters, recurring at the result: a value used as
    // a first-class callable (an object literal's method value, a dispatch-table
    // entry) gets its ABI from THIS function, and an unconsulted census here is
    // exactly what makes `abi.result` publish `dynamic` for a function the
    // census already typed. `resultOverride` still wins outright -- it is a
    // fact about the CALL, not the callee, and the census has nothing to say
    // about it.
    const checkerResult = signature.getReturnType()
    // The RESULT half of the same store `implicitReceiverOf` answers the
    // receiver half of, and it outranks every source below because it IS the
    // slot: a contextually typed object literal is laid out as the declared
    // type (`structural-layout-type.ts`), so its `next` field's carrier is
    // built from `TypedCursor`'s `next(): TypedStep`, while the literal's own
    // unannotated `next() { return { value: 0, done: true } }` derived an
    // ANONYMOUS record of identical shape but different interned identity --
    // two conventions for one member, and no conversion between a named record
    // and an anonymous one (`typed-custom-iterator-close.ts`, both directions:
    // the cursor factory's result and the step's).
    //
    // Gated on the literal method annotating NO return type of its own: a
    // written annotation is the program's own statement about this
    // declaration and still wins, and a declared member with no annotation
    // either leaves both sides on the inference they already shared.
    const declaredMemberResult = (() => {
      if (resultOverride !== undefined || !declaration) return null
      if (!ts.isMethodDeclaration(declaration) || declaration.type !== undefined) return null
      if (!ts.isObjectLiteralExpression(declaration.parent)) return null
      const member = declaredMemberSignatureOf(declaration, declaration.parent)
      if (!member || member.type === undefined) return null
      return checker.getSignatureFromDeclaration(member)?.getReturnType() ?? null
    })()
    // The same statement as `declaredMemberResult` above, one level out: a
    // function LITERAL written straight into a slot whose declared type states
    // the result. The literal annotates no return type of its own, so the
    // slot's statement is the only one the program makes, and the literal's
    // inference of an ANONYMOUS record where the slot names `Events` is two
    // identities for one value -- with no conversion between them, and none
    // possible, because the target is a UNION and a value only widens into a
    // union by already BEING one of its arms. `() => ({ onOpen: () => 2 })`
    // against `((c: Ctx) => Events) | Ctx | Events | number` is the measured
    // case: the argument published `() -> record#<literal>`, and certification
    // refused both the widening of that callable into the tagged union and the
    // store of the body's `Events` into the arrow's own record return slot --
    // two refusals, one disagreement. The identical arrow written
    // `(): Events => ...` certified, which is what named the RESULT as the one
    // slot at fault: the parameter lists never mattered.
    //
    // Union slots only. A non-union slot already reaches the value through
    // `declaredValueTypeOf` (a named binding) or through an ordinary callable
    // conversion, neither of which this may pre-empt. One assignable arm with
    // one call signature only -- two callable arms is a choice this cannot
    // make, and the literal's own inference remains the answer.
    //
    // NARROWED TO THE IDENTITY QUESTION, because a slot's result is not always
    // a restatement of the literal's own: measured over the 342 runtime
    // programs, the rule without the shape test below also fires on every
    // `.then` callback, whose slot result is the WIDER `T | PromiseLike<T>`,
    // and on one slot result of `any`. Adopting either would be a widening --
    // a boxed carrier in the `any` case -- not an identity correction. So it
    // applies only where the literal RETURNS AN OBJECT LITERAL whose inferred
    // type is anonymous and the slot names a record that literal already
    // satisfies: the same shape under two identities, which is the whole
    // defect and the only thing no conversion can bridge. With that test: one
    // site across the 342 runtime programs and none across the 158 corpus
    // fixtures.
    const contextualSlotResult = (() => {
      if (resultOverride !== undefined || !declaration) return null
      if (!ts.isArrowFunction(declaration) && !ts.isFunctionExpression(declaration)) return null
      if (declaration.type !== undefined) return null
      const contextual = checker.getContextualType(declaration)
      if (!contextual || !contextual.isUnion()) return null
      const own = checker.getTypeAtLocation(declaration)
      const arms = contextual.types.filter((member) => member.getCallSignatures().length === 1 && checker.isTypeAssignableTo(own, member))
      const stated = arms.length === 1 ? arms[0]?.getCallSignatures()[0] : undefined
      if (!stated) return null
      const slot = checker.getReturnTypeOfSignature(stated)
      if (slot === checkerResult || slot.isUnion() || (slot.flags & ts.TypeFlags.Object) === 0) return null
      if (!inferredObjectLiteralType(checkerResult) || !checker.isTypeAssignableTo(checkerResult, slot)) return null
      return slot
    })()
    const censusResult = declaration ? parameters.typeAt(declaration) : null
    const censusUnionArms = resultOverride === undefined && declaration ? parameters.unionArmsAt(declaration) : null
    const bagResult = resultOverride === undefined && declaration && table ? bagReturnTypeOf(table, typeOf, bags, declaration) : null
    const collectionResult = (() => {
      if (resultOverride !== undefined || !declaration || !table) return null
      const expressions: ts.Expression[] = []
      const visit = (node: ts.Node): void => {
        if (node !== declaration && ts.isFunctionLike(node)) return
        if (ts.isReturnStatement(node)) {
          if (node.expression) expressions.push(node.expression)
          return
        }
        ts.forEachChild(node, visit)
      }
      if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) expressions.push(declaration.body)
      else {
        const body =
          ts.isFunctionDeclaration(declaration) ||
          ts.isFunctionExpression(declaration) ||
          ts.isArrowFunction(declaration) ||
          ts.isMethodDeclaration(declaration) ||
          ts.isConstructorDeclaration(declaration) ||
          ts.isGetAccessorDeclaration(declaration) ||
          ts.isSetAccessorDeclaration(declaration)
            ? declaration.body
            : undefined
        if (body) visit(body)
      }
      if (expressions.length === 0) return null
      let agreed: StructuralTypeId | null = null
      for (const expression of expressions) {
        const inferred = inferredCollectionTypeArgumentsAt(
          collections,
          table,
          typeOf,
          bags,
          checker.getTypeAtLocation(expression),
          expression
        )
        if (inferred === null || (agreed !== null && inferred !== agreed)) return null
        agreed = inferred
      }
      return agreed
    })()
    // An `async` function's own declared type really IS `Promise<T>` -- this
    // used to unwrap it to `T` here via `checker.getAwaitedType`, making
    // every async function compile as an ordinary synchronous function. That
    // was scaffolding for an earlier false-certification patch (see
    // `.scratch/HANDOVER-2026-08-31-session3.md`), not the target design; it
    // is reverted now that `promise` is a real, statically-typed carrier
    // (`representation/derive.ts`'s `PromiseDeclarationPolicy`). `await`
    // still unwraps at its own site (`contributeAwait`,
    // `producers/control.ts`), which is the only place ECMAScript actually
    // performs this unwrap -- see citations.md finding 2.
    const signatureParameters = signature.getParameters()
    const phantomIndex = implicitArgumentsSlotOf(signature)?.ordinal ?? null
    // A JSDoc closure-style function type (`function(this: T, ...number):
    // string`, the shape `@returns` synthesizes for an ABI-recovery callback)
    // parses its rest parameter into a plain `ts.ParameterDeclaration` with NO
    // `dotDotDotToken` -- there is no `...` token to parse, because the
    // rest-ness is spelled by the JSDoc tag, not by punctuation on a real
    // parameter list. `parameterOf`'s `rest` flag reads `dotDotDotToken`
    // directly and was therefore blind to this shape, silently deriving a
    // FIXED array-typed parameter instead of a runtime-sized rest slot --
    // `test/runtime/dynamic-callable-rest-adapter.runtime.js`'s
    // `recoverMethodRest` return type lost its rest convention this way, and
    // a later `formatted.call(receiver, 4, 5)` had no rest frame to pack `4`
    // and `5` into. `ts.signatureHasRestParameter` is the checker's own
    // semantic answer (it reads the parameter SYMBOL's rest flag, which the
    // JSDoc parser does set), independent of which syntax produced the
    // signature, so it is asked once per signature and applied to the last
    // parameter exactly the way an explicit phantom rest is forced below.
    // Not part of the public `typescript` `.d.ts` (unlike the checker-cast
    // escape hatches elsewhere in this module for the same reason), so it is
    // reached the same way: a narrow, optional-typed cast rather than `any`.
    const hasRestParameter = (ts as unknown as { signatureHasRestParameter?: (signature: ts.Signature) => boolean })
      .signatureHasRestParameter
    const semanticRestIndex = hasRestParameter?.(signature) ? signatureParameters.length - 1 : -1
    // Expand only a checker-authenticated bind protocol tuple. A source
    // function's tuple rest retains the container its body actually binds.
    const parametersOf = (parameter: ts.Symbol, index: number): readonly SignatureParameter[] => {
      const declaration = identities.declarationOfSymbol(parameter)
      if (declaration && ts.isParameter(declaration)) {
        // Mirrors `parameterOf`'s own `declared` precedence exactly (census
        // answer first, the checker's otherwise) so this expansion decision
        // and `parameterOf`'s single-parameter answer can never look at two
        // different types for the same declaration.
        const declared = parameters.typeAt(declaration) ?? typeOfSymbolAt(parameter, declaration)
        const closedElements = closedRestTupleElementsAt(checker, declaration, declared)
        if (closedElements !== null) return closedElements.map(parameterOfTupleElement)
      }
      return [parameterOf(parameter, index === semanticRestIndex)]
    }
    const parameterShapes =
      phantomIndex === null
        ? signatureParameters.flatMap(parametersOf)
        : [
            ...signatureParameters.slice(0, phantomIndex).flatMap(parametersOf),
            parameterOf(signatureParameters[phantomIndex] as ts.Symbol, true)
          ]
    // The census's arguments frame: a closed tuple when every body read names
    // a fixed position (each position its own joined fact, the ones some
    // caller omits optional), the runtime-sized Array of one element when the
    // body indexes it at run time. See `implicit-arguments-tuple.ts`.
    const implicitFrame = declaration && phantomIndex !== null ? parameters.implicitArgumentsTupleAt?.(declaration) : null
    if (implicitFrame && phantomIndex !== null) {
      const parameter = parameterShapes[phantomIndex]
      const type =
        implicitFrame.frame === 'array'
          ? internArray(typeOf(implicitFrame.element))
          : table?.intern({
              kind: 'tuple',
              readonly: false,
              elements: implicitFrame.elements.map((element, position) => ({
                type: typeOf(element),
                optional: position >= implicitFrame.required,
                rest: false,
                variadic: false
              }))
            })
      if (parameter && type !== undefined) parameterShapes[phantomIndex] = { ...parameter, type, slot: type }
    }
    return {
      parameters: parameterShapes,
      minimumArity: minimumArityOf(signature),
      // An explicit `this` is a type-system device, not an argument. Keeping it
      // out of the parameter list is what stops it becoming a physical argument.
      thisParameter: receiverType,
      result:
        (declaredMemberResult ? typeOf(declaredMemberResult) : null) ??
        (contextualSlotResult ? typeOf(contextualSlotResult) : null) ??
        bagResult ??
        collectionResult ??
        (censusUnionArms ? input.internUnion(censusUnionArms.map(typeOf)) : typeOf(resultOverride ?? censusResult ?? checkerResult))
    }
  }

  /**
   * The expression a member's OWN declaration states its value from, when that
   * declaration is one of the shapes `parameters` (the fully composed
   * parameter+return+local+field census, despite the name -- see
   * `frontend.ts`'s `compose`) already knows how to answer about: an object
   * LITERAL property's initializer (`shaderID: shaderID` -- the identifier
   * `shaderID` is exactly the node `local-bindings.ts` published an answer
   * for), or a shorthand property's own name (`{ shaderID }`, which names the
   * same outer binding). A class field's declaration is one one of its OWN
   * writes -- `field-bindings.ts` already joins every write reaching the
   * FIELD's symbol under one answer, so the declaration node itself, not its
   * "value", is what should be asked; see the call site below.
   */
  const censusValueNodeOf = (declaration: ts.Declaration): ts.Node | null => {
    if (ts.isPropertyAssignment(declaration)) return declaration.initializer
    if (ts.isShorthandPropertyAssignment(declaration)) return declaration.name
    return null
  }

  /** Accessor members currently being resolved through their passthrough target; see `memberOf`. */
  const passthroughSeen = new Set<ts.Symbol>()

  /**
   * `location` is a FALLBACK, never an override: a member with its own
   * declaration is always asked at that declaration, and the borrowed location
   * only ever answered for a member that has none. `null` is admitted because
   * that borrowed answer is not always available and was never needed --
   * `typeOfSymbolAt` asks the location-free question instead. See
   * `structural.ts`'s declarationless-object branch.
   */
  const memberOf = (symbol: ts.Symbol, location: ts.Node | null): StructuralMember | null => {
    if (memberDebug === symbol.name) process.stderr.write(`\n[MEMBER-ENTER] ${symbol.name}\n`)
    const key = keyOfSymbol(symbol)
    if (!key) return null
    // An accessor pair that does nothing but forward to another field IS that
    // field, so it must be answered by the SAME authority -- this function,
    // recursively -- rather than by its own annotation. See
    // `accessorPassthroughMemberTargetOf`: three's `Texture.image` is
    // `get image() { return this.source.data }` carrying `@type {?Object}`,
    // and that upper bound otherwise wins outright over the census that knows
    // the slot holds `Source.data`.
    //
    // Only the TYPE is taken from the target. `optional`, `readonly` and the
    // accessor bodies stay this member's own, because those are facts about
    // how the alias is spelled here, not about the storage behind it.
    //
    // `passthroughSeen` is a cycle guard, not an optimisation: a pair of
    // accessors forwarding to each other is a program this must refuse rather
    // than recurse forever on.
    if (!passthroughSeen.has(symbol)) {
      const target = accessorPassthroughMemberTargetOf(checker, symbol)
      if (target) {
        passthroughSeen.add(symbol)
        try {
          const forwarded = memberOf(target.symbol, target.declaration)
          if (forwarded)
            return { ...forwarded, key, accessor: literalAccessorOf(symbol, identities) ?? declaredMembers.accessorBodiesOf(symbol) }
        } finally {
          passthroughSeen.delete(symbol)
        }
      }
    }
    const declaration = identities.declarationOfSymbol(symbol)
    const checkerAnswer = typeOfSymbolAt(symbol, declaration ?? location ?? undefined)
    // The checker answers an object-literal PROPERTY's or a class FIELD's own
    // type by asking the checker DIRECTLY at the member's declaration -- a
    // question the checker itself can only answer from what IT can see, which
    // for `shaderID: shaderID` (the value an unannotated `x[k]` index read
    // produced) or `this.morphTargetDictionary = Object.assign({}, ...)` (a
    // self-referential write the checker's own JS inference gives up on) is
    // `any`, even though `parameters` -- the SAME composed census `structural.ts`
    // already threads through this module for PARAMETER declarations
    // (`parameterOf` above) -- has a real, better answer for the identical
    // symbol via `local-bindings.ts`/`field-bindings.ts`. Consulted only as a
    // FALLBACK, and only past the checker's own unusable-evidence gate: a
    // checker answer that IS usable is never second-guessed here, the same
    // discipline `parameter-bindings.ts`'s own `known()` keeps for a bound
    // parameter's narrowed use.
    const censusNode = declaration ? (censusValueNodeOf(declaration) ?? declaration) : null
    const fromCensus = isUnusableEvidence(checkerAnswer) && censusNode ? parameters.typeAt(censusNode) : null
    // Which of the three sources actually answered one named member. A record
    // that carries ONE dynamic field among 130 gives the reader no way to tell
    // "the checker was fine" from "the census had nothing to add".
    if (memberDebug === symbol.name) {
      const where = censusNode?.getSourceFile()
      process.stderr.write(
        `[MEMBER] ${symbol.name} checker=${checker.typeToString(checkerAnswer)} unusable=${isUnusableEvidence(checkerAnswer)} ` +
          `censusNode=${censusNode ? ts.SyntaxKind[censusNode.kind] : 'none'}@${where ? `${where.fileName.split('/').pop()}:${where.getLineAndCharacterOfPosition(censusNode!.getStart()).line + 1}` : '-'} ` +
          `fromCensus=${fromCensus ? checker.typeToString(fromCensus) : 'null'}\n`
      )
    }
    // A STATED ANNOTATION THAT WAS ONLY EVER AN UPPER BOUND, and -- exactly as
    // in `structural-layout-type.ts`'s `layoutTypeAt`, which takes it FIRST for
    // the same reason -- the one census answer this module takes over a checker
    // answer it is happy with. The `isUnusableEvidence` gate above cannot serve
    // it: the checker's answer for hono's `#matchResult: Result<[unknown,
    // RouterRoute]>` is a perfectly good two-armed union of tuples, and the
    // fact is that its one `unknown` leaf is filled in concretely by the
    // program's only writer. This is the ABI side of that one storage
    // location; the body side already answers the narrowing, so leaving this
    // on the checker is what makes them two authorities -- a field "stored as"
    // the annotation while every read of it "publishes" the narrowing, which
    // is a refusal at the store and again at the return that hands it back.
    const narrowedByStatement = censusNode ? parameters.statedTypeAt(censusNode) : null
    const declared = narrowedByStatement ?? fromCensus ?? checkerAnswer
    // A member initialized with a function literal carries the LITERAL's one
    // convention, not its annotation's overload set -- see
    // `physicalInitializerTypeOf`. `null` for every other member, which is
    // then asked exactly as before.
    const physical = declaration === null ? null : physicalInitializerTypeOf(checker, declaration, declared, parameters)
    // `private store = new Map()` types `store` as `Map<unknown, unknown>` --
    // a real, non-`any` type, so `isUnusableEvidence` above never fires and
    // `fromCensus` is never even asked. That is not a gap `parameters` above
    // could close anyway: `collection-bindings.ts`'s answer is a different
    // census, keyed by a different node (the allocation or the owning
    // declaration, not a value-flow write into the field's OWN symbol). Asked
    // here, past `physical`, so a member the checker already resolved through
    // a function literal keeps that answer untouched -- a keyed-collection
    // field is never also that shape. See this field's own `collections`/
    // `table` doc above and `inferredCollectionTypeArgumentsAt`'s header
    // (`structural-array-element.ts`) for why the checker's answer needs a
    // second opinion here at all.
    const inferredCollection =
      table && declaration ? inferredCollectionTypeArgumentsAt(collections, table, typeOf, bags, declared, declaration) : null
    const arrayElement = censusNode
      ? inferredArrayElementAt(checker, collections, (node) => checker.getTypeAtLocation(node), censusNode)
      : null
    const inferredArray = arrayElement ? internArray(typeOf(arrayElement)) : null
    // The field half of an open bag must ask the same owner-keyed census as
    // every read. This matters most for a JavaScript assignment declaration:
    // `this.children = {}` is checker-typed as `{}`, yet its computed writes
    // state an index of native `Child` instances. A class anchor is already
    // reserved while its body is built, so feeding that concrete index through
    // the bag shape closes a finite Child -> Parent.children -> Child cycle at
    // the nominal identity. Leaving the member at the checker-empty object
    // creates two carriers for one cell and turns that finite recurrence into
    // an unresolved expression/binding cycle downstream.
    const inferredBag = table && declaration ? bagShapeTypeAt(table, typeOf, bags, declaration) : null
    const optional = (symbol.getFlags() & ts.SymbolFlags.Optional) !== 0
    const arraySlot = inferredArray && optional ? input.internUnion([inferredArray, typeOf(checker.getUndefinedType())]) : inferredArray
    // ⛔ An optional member's ABSENCE is a state of its own and has to be in
    // the member's TYPE, because that type is the only thing
    // `representation/` derives the field's carrier from -- `recordFieldsOf`
    // never wraps on the `optional` flag beside it, and nothing downstream
    // does either.
    //
    // Under `exactOptionalPropertyTypes` the checker does NOT put it there:
    // `slot?: Extension | null` reports `Extension | null`, and that alone is
    // a silent miscompile. `representation/optional.ts` collapses `T | null`
    // onto a refcounted reference, so the field became a bare
    // `gea::Ref<Extension>` whose only absent state, `nullptr`, was already
    // spoken for by `null` -- and `{}` read its slot back as `null`.
    // `test/fixtures/optional-slot-holds-null.ts` printed `null,null,value:7`
    // where the language says `absent,null,value:7`: compiled, linked, ran,
    // wrong. Widening restores the third state, and `union.ts` gives it an
    // arm of its own.
    //
    // A no-op wherever the checker already answered with `undefined` in the
    // union -- which is every optional member without
    // `exactOptionalPropertyTypes`, and every one whose payload cannot
    // absorb an absence -- so this adds a state only where one was missing.
    const stated = physical ?? declared
    return {
      key,
      type:
        inferredBag ??
        arraySlot ??
        inferredCollection ??
        typeOf(optional ? checker.getNullableType(stated, ts.TypeFlags.Undefined) : stated),
      optional,
      readonly:
        declaration !== null && ts.canHaveModifiers(declaration)
          ? (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
          : false,
      // The literal's own bodies first; then the ones an implementer supplies
      // for a member this DECLARED shape spells as data.
      accessor: literalAccessorOf(symbol, identities) ?? declaredMembers.accessorBodiesOf(symbol)
    }
  }

  const indexesOf = (type: ts.Type): readonly StructuralIndexShape[] =>
    checker.getIndexInfosOfType(type).flatMap((info): StructuralIndexShape[] => {
      const key =
        info.keyType.flags & ts.TypeFlags.String
          ? ('string' as const)
          : info.keyType.flags & ts.TypeFlags.Number
            ? ('number' as const)
            : info.keyType.flags & ts.TypeFlags.ESSymbolLike
              ? ('symbol' as const)
              : null
      return key ? [{ key, value: typeOf(info.type), readonly: info.isReadonly }] : []
    })

  const tupleElementsOf = (type: ts.TupleTypeReference): readonly TupleElement[] => {
    const target = type.target
    return checker.getTypeArguments(type).map((argument, index): TupleElement => {
      const flags = target.elementFlags[index] ?? ts.ElementFlags.Required
      return {
        type: typeOf(argument),
        optional: (flags & ts.ElementFlags.Optional) !== 0,
        rest: (flags & ts.ElementFlags.Rest) !== 0,
        variadic: (flags & ts.ElementFlags.Variadic) !== 0
      }
    })
  }

  /**
   * Whether a member is per-value storage rather than shared behavior.
   *
   * A method and an accessor are installed once, on a prototype; a property is
   * a slot in the value. A property that *holds* a function (`onClick: () =>
   * void`) is storage, and the symbol flags are what tell the two apart -- not
   * the type of the value the member holds.
   */

  return { signatureOf, memberOf, indexesOf, tupleElementsOf }
}

// A callable (a method's own function type) can end up the OUTER frame of a
// walking collision purely by processing order: the census does not promise
// an object literal's own allocation runs before one of its methods', and
// `objectShapeOf`'s member walk can re-enter a method's own signature type
// via `checker.getTypeOfSymbolAtLocation`, which hands back the identical
// `ts.Type` the census started from. When that happens, THIS is the type
// `selfReferentialShapeOf` retries -- and none of its four modelled kinds
// (union, intersection, tuple, array) match a callable. Giving it the plain
// `signature` shape the ordinary call-signature branch would have produced
// is correct: the object it references as `this` is anchored separately, so
// re-deriving the signature only needs to avoid degrading to `unresolved`
// for a shape this layer genuinely knows how to build. Lives here, beside
// `signatureOf` itself, since `structural.ts` is at its file-length cap.
export const selfReferentialCallableShapeOf = (
  type: ts.Type,
  signatureOf: (signature: ts.Signature) => SignatureShape
): { kind: 'signature'; call: SignatureShape[]; construct: SignatureShape[] } | null => {
  const callSignatures = type.getCallSignatures()
  const constructSignatures = type.getConstructSignatures()
  if (callSignatures.length === 0 && constructSignatures.length === 0) return null
  return {
    kind: 'signature',
    call: callSignatures.map((one) => signatureOf(one)),
    construct: constructSignatures.map((one) => signatureOf(one))
  }
}
