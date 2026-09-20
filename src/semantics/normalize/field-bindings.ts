import ts from 'typescript'
import { inheritedAccessorOfAssignment } from '../inherited-accessor.js'
import {
  annotationStatesNothing,
  containsUnstatedPosition,
  derivedExpressionType,
  disjointUnionMembersOf,
  exactEmptyObjectLiteralType,
  indexedTypeOf,
  explicitThisCallReturnType,
  overloadInvariantReturnTypeAt,
  joinOfWrites,
  jsDocTypeStatesNothing,
  literalMemberNameOf,
  narrowsOnlyUnstatedPositions,
  memberTypeOf,
  objectAssignTargetType,
  unwrapExplicitThisCall
} from './derived-expression-type.js'
import { carriesUnsubstitutedGeneric, emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { emptyCollectionBindingCensus, type CollectionBindingCensus } from './collection-bindings.js'
import type { ValueFlowIndex, ValueWrite } from './flow/model.js'
import { classFamilyMemberReadTypeOf } from './flow/class-family-member-read.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'

/**
 * The type an unannotated class FIELD holds, when the program never declares
 * it and only ever assigns it -- `this.view = null;` in `OrthographicCamera`'s
 * constructor, reassigned a real object later in `setViewOffset`. TypeScript's
 * own JS-class inference DOES give `view` a symbol from these assignments
 * alone (no `view;` field declaration exists anywhere in the class), but
 * `symbol.declarations` for it is a bare list of the `BinaryExpression`
 * assignments themselves -- there is no annotation, no initializer at a
 * single site, nothing else for the checker to read -- and the checker's own
 * answer for the property lands on `any`.
 *
 * This is `local-bindings.ts`'s exact question -- an unannotated storage
 * location typed by joining every write to it -- asked of a different
 * DECLARATION KIND. A `let`/`var` cell is keyed by its `VariableDeclaration`
 * node and filled from `assignmentsBySymbol`; a class field has no
 * declaration node of its own at all, only a SYMBOL whose every declaration
 * IS one of the writes. So this module keys directly on that symbol instead
 * of re-deriving one from a declaration list, and otherwise runs the
 * identical join: `known(write) ?? resolveExpr(write)` at every assignment's
 * right-hand side, the shared `joinOfWrites` to settle on one carrier, refuse on
 * disagreement or unusable evidence, stop at an `as`/`<T>` cast.
 *
 * ## Why a field is safe to publish where a bare cell needed care
 *
 * `local-bindings.ts`'s own header records why publishing a no-initializer
 * cell's type at its DECLARATION once manufactured twelve spurious
 * `binding-read-conversion` obligations: the declare-site and some read of
 * the same cell answered two different types. That risk was about
 * INCONSISTENCY between two authorities, not about publishing a write-set
 * join per se -- and this module inherits the same cure `local-bindings.ts`
 * used: `typeAt` answers a field's own write sites AND every read that
 * resolves to the same symbol from the ONE `resolveSymbol` computation, so
 * the two can never drift apart. A field additionally has no bare
 * "declare, no initializer" cell state at all -- `producers/bindings.ts`'s
 * `declare` action is a `let`/`var` idiom; a field is written by an ordinary
 * property-assignment operation from its very first write, so there is no
 * analogous zero-value moment this module's answer could contradict.
 *
 * ## What it refuses
 *
 * Every refusal leaves the field exactly as it is today -- `any`, boxed --
 * because a wrong type is far worse than a boxed one:
 *
 * - any symbol carrying a REAL declaration the program gave a TYPE -- an
 *   annotated field, one with its own initializer, a JSDoc-typed member, a
 *   getter/setter: the program already said something, or an existing
 *   authority already answers it.
 * - any write whose own type is unusable evidence (`any`/`void`/`never`) or
 *   otherwise unresolved -- identical to `local-bindings.ts` and
 *   `parameter-bindings.ts`.
 * - two or more writes whose types genuinely disagree, tested with
 *   `derived-expression-type.ts`'s shared `joinOfWrites`: agreement is never
 *   spelling, and a union of this compiler's own making is a guess nobody
 *   wrote.
 * - a field whose resolution depends on itself, directly or through another
 *   field's/cell's own unresolved write: refused rather than looped.
 *
 * ## The second shape: a BARE `field;` declaration
 *
 * `class Camera { aspect; }` -- a `PropertyDeclaration` with no annotation,
 * no initializer and no JSDoc tag -- states that the storage EXISTS and
 * nothing whatever about what it holds; the checker's own answer for it is
 * `any`. The original rule turned every `PropertyDeclaration` away on the
 * reasoning that "TypeScript already reads an unannotated field
 * declaration's own initializer", which is true of `aspect = 1;` and vacuous
 * for `aspect;`: there is no initializer to read, so nothing reads anything
 * and every `camera.aspect` boxes.
 *
 * That is the SAME question this module already answers one shape over --
 * storage the program declared but never typed, filled by the writes the
 * program makes to it -- so it is answered from the same `resolveSymbol`
 * join rather than by a second module with a second opinion. The only
 * difference is where the writes come from: a field with no declaration at
 * all finds them in `symbol.declarations` (every declaration IS a write),
 * while a bare-declared field has exactly one declaration and its writes
 * have to be gathered from the program, exactly as `local-bindings.ts`
 * gathers a `let` cell's with `assignmentsBySymbol`.
 *
 * ## Per-HIERARCHY, deliberately
 *
 * Identity here is the SYMBOL, never the spelling -- so a subclass writing
 * `this.aspect = ...` against a base that declares `aspect;` contributes to
 * the BASE symbol's join, because TypeScript's own property lookup resolves
 * that write to the base's declaration. That is the correct scope: there is
 * ONE storage slot, declared on the base, and every subclass writes it. A
 * subclass that RE-declares `aspect;` shadows the base slot with a second
 * symbol and gets its own independent join -- also correct, and also a
 * consequence of keying on the symbol rather than on the name.
 *
 * This complements `subclass-member-overlay-transform.ts` rather than
 * overlapping it: that transform states a member the base NEVER declares,
 * from the subclasses that do; this types a slot the base DOES declare and
 * nobody annotates. A symbol that transform has already given a JSDoc type
 * is, by the rule above, no longer a candidate here.
 */
export interface FieldBindingCensus {
  /**
   * The type this node holds, once an unannotated field carries what its
   * assignments (jointly) produce -- or `null` when nothing here improves on
   * the checker's/upstream census's own answer. Answers at ANY node whose
   * resolution passes through a bound field: a `this.field = value` write's
   * own left-hand side, a `this.field` read, or a chain through either.
   */
  readonly typeAt: (node: ts.Node) => ts.Type | null
  /** The member list for a SYNTHESIZED disjoint-union carrier at this node -- see `ParameterBindingCensus.unionArmsAt`, the same rule asked of a field's write set instead of a parameter's argument set. */
  readonly unionArmsAt: (node: ts.Node) => readonly ts.Type[] | null
  /**
   * The narrowed type of a field whose ANNOTATION this census read as an upper
   * bound -- the field form of `ParameterBindingCensus.statedTypeAt`, and
   * needed for the identical reason: `structural-layout-type.ts`'s ordinary
   * census fallback fires only where the checker answered `any` or a vacuous
   * type, and the whole point of a stated field is that the checker's answer
   * is a perfectly good structure with one unstated leaf. Answers at the
   * declaration and at every property access that resolves to it, from the
   * one `resolveSymbol` computation, so the cell and its reads cannot split.
   */
  readonly statedTypeAt: (node: ts.Node) => ts.Type | null
  /** How many field symbols this census bound, for measurement. */
  readonly boundCount: number
  /**
   * Every field symbol this census could not bind, one `CensusRefusal` each --
   * the owner is what makes this a list something downstream can act on,
   * rather than a count that says a cell went untyped without saying which.
   * `census-refusal.ts`'s `censusRefusalCounts` derives the old count-per-
   * reason map for any reader that still wants that shape.
   */
  readonly refusals: readonly CensusRefusal[]
  /** Why this particular field symbol was not bound. */
  readonly refusalOf: (symbol: ts.Symbol) => string | null
}

/** A census that binds nothing, for callers that state no program. */
export const emptyFieldBindingCensus: FieldBindingCensus = {
  typeAt: () => null,
  unionArmsAt: () => null,
  statedTypeAt: () => null,
  boundCount: 0,
  refusals: [],
  refusalOf: () => null
}

const WIDENED = process.env['GEA_FLOW_WIDE'] === '1'

const isAnyType = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Any) !== 0

/** Duplicated from `parameter-bindings.ts` (not exported there): `any`/`void`/`never` say nothing about storage. */
const isUnusableEvidence = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

/**
 * `never[]` (or `readonly never[]`) -- TypeScript's own answer for `this.x =
 * [];` with no contextual type to narrow it, and no more a fact about the
 * program than the empty object type `{}` is; `annotationStatesNothing`
 * already carries that reasoning for `{}` (see its own comment) but never
 * asked the array-shaped version of the same question, so a field whose only
 * whole-value write is a bare `[]` was read as REAL evidence -- bound to
 * `never[]`, a type nothing can ever be assigned into or read out of, in
 * front of every other write the program plainly makes to it (a `.push`, a
 * computed-index write) elsewhere in the class. Same test
 * `object-bag-bindings.ts`'s `statesNothing` already applies to a bag's own
 * candidacy, asked here of a FIELD's write evidence instead.
 *
 * `any[]` and `unknown[]` are the same statement, and the test asked only the
 * `never` half. `isUnusableEvidence` already refuses a bare `any` because it
 * says nothing about what a slot holds; an array OF `any` says nothing about
 * what its elements hold, and the only difference is one level of nesting.
 * three's `Texture.mipmaps` is the measured case: `@type {Array<Object>}`,
 * where the global `Object` INTERFACE is collapsed to `any` by
 * `structural.ts`'s `isGlobalObjectInterface` for the same reason
 * `annotationStatesNothing` refuses it bare -- so the annotation arrives here
 * as `any[]`, read as REAL evidence, and the field's write set (which the
 * program plainly fills with real mip records) was never consulted at all.
 */
const isVacuousArrayType = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if (!checker.isArrayType(type)) return false
  const [element] = checker.getTypeArguments(type as ts.TypeReference)
  return element !== undefined && (element.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
}

/**
 * The internal (undocumented, but present and correct on every TypeScript
 * version this compiler pins) checker methods that build an INDEX SIGNATURE
 * type -- `{ [k: string]: V }` -- over a given value type, constructed
 * rather than looked up, because the public checker API has no way to state
 * "the dictionary type whose value is this type I just joined". These are
 * the SAME functions the checker's own inference uses internally (verified
 * end-to-end, including class-typed values, against this exact TypeScript
 * version before use here); an unbound, hand-built `TypeNode` round-tripped
 * through `getTypeFromTypeNode` was tried first and measured unreliable for
 * anything but a primitive value (a synthetic `TypeReferenceNode` for a
 * class resolves to `any`, silently, because it was never bound by the
 * parser) -- these operate directly on already-resolved `ts.Type` objects
 * instead, so no binding is needed and no value type can silently degrade.
 * A checker that lacks either method silently answers `null` here rather
 * than guessing some other way.
 */
interface DictionaryConstructingChecker {
  createIndexInfo(keyType: ts.Type, type: ts.Type, isReadonly: boolean): ts.IndexInfo
  createAnonymousType(
    symbol: ts.Symbol | undefined,
    members: ts.SymbolTable,
    callSignatures: readonly ts.Signature[],
    constructSignatures: readonly ts.Signature[],
    indexInfos: readonly ts.IndexInfo[]
  ): ts.Type
}
// The constructor allocates a fresh anonymous checker type. Intern by its
// complete inputs so repeated inference rounds publish the same fact identity.
const dictionaryTypes = new WeakMap<ts.TypeChecker, Map<ts.Type, ts.Type>>()
const dictionaryTypeOf = (checker: ts.TypeChecker, valueType: ts.Type): ts.Type | null => {
  const cached = dictionaryTypes.get(checker)?.get(valueType)
  if (cached) return cached
  const constructing = checker as unknown as Partial<DictionaryConstructingChecker>
  if (typeof constructing.createIndexInfo !== 'function' || typeof constructing.createAnonymousType !== 'function') return null
  const indexInfo = constructing.createIndexInfo(checker.getStringType(), valueType, false)
  const dictionary = constructing.createAnonymousType(undefined, new Map(), [], [], [indexInfo])
  if (!dictionary || checker.getIndexInfosOfType(dictionary).length === 0) return null
  let cache = dictionaryTypes.get(checker)
  if (!cache) {
    cache = new Map()
    dictionaryTypes.set(checker, cache)
  }
  cache.set(valueType, dictionary)
  return dictionary
}

/** The internal checker method backing a union type literal (`ts.Type[] -> ts.Type`); same category as `DictionaryConstructingChecker` above. */
interface UnionConstructingChecker {
  getUnionType(types: readonly ts.Type[]): ts.Type
}
/** `type | null | undefined`, joining ONLY the nullish members of `nullish` -- a real `undefined`/`null` write the field's own whole-value evidence made is a FACT this module must not drop just because a separate pool of evidence (a write made THROUGH the field) answered its shape. */
const withNullish = (checker: ts.TypeChecker, type: ts.Type, nullish: readonly ts.Type[]): ts.Type | null => {
  if (nullish.length === 0) return type
  const constructing = checker as unknown as Partial<UnionConstructingChecker>
  if (typeof constructing.getUnionType !== 'function') return null
  return constructing.getUnionType([type, ...nullish])
}

/** A plain `x.field = expr` assignment -- what TypeScript's JS-class inference leaves in `declarations` for a field the program never declares. */
const isAssignmentDeclaration = (declaration: ts.Declaration): boolean =>
  ts.isBinaryExpression(declaration) && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken

/**
 * Whether a declaration is ambient (`declare class C { x }`, or anything
 * nested inside a `declare module`) -- the same test `local-bindings.ts`
 * applies to a cell, for the same reason: a host owns that storage, so its
 * type is a host-boundary capability question and never this module's to
 * answer.
 */
const isAmbientDeclaration = (node: ts.Node): boolean => {
  if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0) return true
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * A `PropertyDeclaration` that states storage and nothing else: `aspect;`.
 * No annotation, no initializer and no JSDoc `@type` -- each of which is the
 * program stating an answer this module must not contradict -- and not
 * ambient, and not in a `.d.ts`. See the module doc comment's "The second
 * shape".
 *
 * A JSDoc tag that resolves to NOTHING is not a statement, which is why the
 * test is `jsDocTypeStatesNothing` rather than the tag's mere presence --
 * the same distinction `local-bindings.ts`'s own `isCandidate` draws, and for
 * the same reason: the checker degrades a tag naming an unbindable type to
 * `any`, so reading presence alone excludes a field the program described
 * and then records it as declared-dynamic.
 */
const isBareFieldDeclaration = (checker: ts.TypeChecker, declaration: ts.Declaration): boolean => {
  if (!ts.isPropertyDeclaration(declaration)) return false
  if (declaration.type || declaration.initializer) return false
  if (declaration.getSourceFile().isDeclarationFile) return false
  const jsDocType = ts.getJSDocType(declaration)
  if (jsDocType && !jsDocTypeStatesNothing(checker, jsDocType)) return false
  return !isAmbientDeclaration(declaration)
}

/**
 * A field the program DID type, whose statement is still only an UPPER BOUND
 * -- the FIELD form of `parameter-bindings.ts`'s `statedUpperBound`, and the
 * same question about the same kind of storage: an annotation with an
 * `any`/`unknown`/bare-`Function` position somewhere inside it, satisfied at
 * every position it constrains by what the program actually writes there.
 *
 * hono's `HonoRequest` is the measured case, and it is why this exists at all.
 * Its constructor parameter `matchResult: Result<[unknown, RouterRoute]>` is
 * already narrowed to the concrete `Result<[H, RouterRoute]>` its only caller
 * passes, by exactly the parameter rule above. The FIELD it is stored into,
 * `#matchResult: Result<[unknown, RouterRoute]>`, kept the annotation -- so
 * the cell held the stated type while its one writer held the narrowed one,
 * and the store between them asked the backend to reconcile two `Result`
 * carriers. That reconciliation rebuilds two arrays, and an array rebuild is
 * a COPY of an array the caller still holds, so it is not renderable at all:
 * the carriers have to be made to AGREE here rather than converted there.
 *
 * An INITIALIZED field is excluded: the initializer is a write, and this
 * module's write discovery reads property-assignment edges, not initializers,
 * so joining without it would answer from a strict subset of the evidence.
 * An OPTIONAL field's statement is `T | undefined` whatever the annotation
 * spells, for the same reason a defaulted parameter's is.
 */
const statedUpperBoundOfField = (checker: ts.TypeChecker, declaration: ts.Declaration): ts.Type | null => {
  if (!ts.isPropertyDeclaration(declaration)) return null
  if (!declaration.type || declaration.initializer) return null
  if (declaration.getSourceFile().isDeclarationFile) return null
  if (isAmbientDeclaration(declaration)) return null
  const declared = checker.getTypeFromTypeNode(declaration.type)
  // A whole annotation that states nothing is `isBareFieldDeclaration`'s
  // business one shape over, not an upper bound to narrow within.
  if (annotationStatesNothing(checker, declaration.type, declared)) return null
  if (isUnusableEvidence(declared)) return null
  if (!containsUnstatedPosition(checker, declaration.type, declared)) return null
  return declaration.questionToken ? checker.getNullableType(declared, ts.TypeFlags.Undefined) : declared
}

/**
 * The INTERFACE a field's annotation names, when it names exactly one.
 *
 * JavaScript has no interfaces. An `interface` annotation states what may be
 * READ out of a slot; it never says what the slot physically holds, because
 * nothing in the language ever constructs one. What the slot holds is whatever
 * the program writes into it -- and when every write is an instance of one
 * class, that class IS the storage.
 *
 * hono is the measured case and it is not a boxing question, it is a
 * CORRECTNESS one. `HonoBase.router` is annotated `Router<[H, RouterRoute]>`,
 * an interface whose members are `name`, `add` and `match`; the constructor
 * writes `new PatternRouter()` and nothing else ever writes it. Carried as the
 * interface, the field became a struct with two `gea::CallableObject` members
 * that nothing could fill (a class's methods are free functions taking the
 * instance, not storage), the class instance would not assign into it at all,
 * and -- worse than either -- `PatternRouter.add`/`.match` were never reached
 * through the class, so the census never walked them and NO BODY FOR EITHER
 * WAS EMITTED. The program compiled its router away.
 *
 * Deliberately narrower than `statedUpperBoundOfField` above, which asks
 * whether an annotation left a position UNSTATED and narrows within it. This
 * asks a different question -- whether the annotation names a shape rather
 * than a thing -- so the answer is held to a different test in `resolveSymbol`:
 * the join must be a CLASS, and assignable to the interface. Anything else
 * (two classes, an object literal, a plain type) refuses and leaves the field
 * exactly as it is.
 */
const interfaceAnnotationOfField = (checker: ts.TypeChecker, declaration: ts.Declaration): ts.Type | null => {
  if (!ts.isPropertyDeclaration(declaration)) return null
  if (!declaration.type || declaration.initializer || declaration.questionToken) return null
  if (declaration.getSourceFile().isDeclarationFile) return null
  if (isAmbientDeclaration(declaration)) return null
  const declared = checker.getTypeFromTypeNode(declaration.type)
  if (isUnusableEvidence(declared)) return null
  const declarations = declared.getSymbol()?.declarations
  const sole = declarations && declarations.length === 1 ? declarations[0] : undefined
  return sole && ts.isInterfaceDeclaration(sole) ? declared : null
}

/** The interface annotation of the field `symbol` declares -- `null` unless it has exactly one declaration and that declaration names one. */
const interfaceBoundOfSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null => {
  const declarations = symbol.declarations
  const sole = declarations && declarations.length === 1 ? declarations[0] : undefined
  return sole ? interfaceAnnotationOfField(checker, sole) : null
}

/** Whether a type is a CLASS INSTANCE -- a thing the program constructs, as opposed to a shape it describes. */
const isClassInstanceType = (type: ts.Type): boolean => {
  const symbol = type.getSymbol()
  if (!symbol || (symbol.flags & ts.SymbolFlags.Class) === 0) return false
  const declaration = symbol.valueDeclaration
  return declaration !== undefined && ts.isClassLike(declaration)
}

/** The stated upper bound of the field `symbol` declares, with the declaration that states it -- `narrowsOnlyUnstatedPositions` needs the node as its anchor. `null` unless `symbol` has exactly one declaration and it is one; see `statedUpperBoundOfField`. */
const statedBoundOfSymbol = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): { readonly declaration: ts.Declaration; readonly bound: ts.Type } | null => {
  const declarations = symbol.declarations
  const sole = declarations && declarations.length === 1 ? declarations[0] : undefined
  if (!sole) return null
  const bound = statedUpperBoundOfField(checker, sole)
  return bound ? { declaration: sole, bound } : null
}

/**
 * An assignment declaration (`this.x = expr;`) carrying its OWN JSDoc
 * `@type` tag that states the slot's storage COMPLETELY -- not vacuous
 * itself (`annotationStatesNothing`) and with no unstated position anywhere
 * inside it (`containsUnstatedPosition`).
 *
 * TypeScript's JS-class inference builds an assignment-only field's
 * declaration list from every `this.x = expr` alone, so `isCandidateSymbol`'s
 * first shape ("the whole list is assignments") used to admit one as a
 * fully-UNANNOTATED field regardless of a JSDoc comment sitting directly
 * above the assignment -- even though `ts.getJSDocType` reads that comment
 * from a `BinaryExpression` exactly as it does from a `PropertyDeclaration`,
 * and the checker's own `getTypeOfSymbolAtLocation` already uses it for the
 * symbol's type: three's `/** @type {Array<Plane>} *\/ this.clippingPlanes =
 * [];` types the SYMBOL `Plane[]`, in full, from the tag alone. A
 * `PropertyDeclaration` this fully stated is excluded from candidacy
 * entirely -- this module's own doc below says why ("an annotated ... field
 * ... means the program DID state something ... this module defers") -- but
 * an assignment declaration carrying the identical statement was never asked
 * the question.
 *
 * Left a CANDIDATE, this manufactures a refusal STRICTLY WORSE than doing
 * nothing: `compute`'s `PropertyAccessExpression` case returns whatever
 * `resolveSymbol` answers the instant `isCandidateSymbol` is true, never
 * falling through to `propertyTypeOf`/`memberTypeOf` -- the ordinary
 * checker-backed lookup that would have read the JSDoc-informed `Plane[]`
 * directly. So a field the program fully described boxed every read of it,
 * for want of a check a sibling shape (`isBareFieldDeclaration`) already
 * makes for the OTHER declaration kind. Measured on the three.js app:
 * `WebGLRenderer.clippingPlanes` and `UniformsGroup.uniforms`, each written
 * once as an empty literal the evolving-array checker calls `never[]`
 * (correctly silent as evidence -- see `resolveSymbol`'s `write-unresolved`)
 * and annotated `Array<Plane>`/`Array<Uniform>` directly above that one
 * write: fully concrete container types the program already committed to,
 * refused here for want of ever reading the annotation.
 *
 * Deliberately narrower than "any JSDoc-typed assignment": `Array<Object>`
 * (three's `updateRanges`/`coefficients`, same shape, same single silent
 * write) has an UNSTATED position (`Object` states nothing on its own,
 * `containsUnstatedPosition` agrees) and stays a candidate, unaffected by
 * this check -- narrowing that kind of annotation from write evidence is the
 * THIRD shape's job (`statedUpperBoundOfField`), not this one's, and a field
 * whose only write is silent still has no evidence to narrow with, so it
 * keeps refusing exactly as before rather than being declared "fully
 * described" when the annotation itself says otherwise.
 */
const assignmentStatesCompleteJsDocType = (checker: ts.TypeChecker, declaration: ts.Declaration): boolean => {
  if (!ts.isBinaryExpression(declaration)) return false
  const jsDocType = ts.getJSDocType(declaration)
  if (!jsDocType) return false
  const declared = checker.getTypeFromTypeNode(jsDocType)
  if (isUnusableEvidence(declared)) return false
  if (annotationStatesNothing(checker, declaration, declared)) return false
  return !containsUnstatedPosition(checker, declaration, declared)
}

/**
 * Whether `symbol` is one of the two shapes this module types: a property
 * whose ENTIRE declaration list is plain `x.field = expr` assignments (no
 * declaration at all -- TypeScript's own JS-class inference), or one declared
 * exactly once as a BARE `field;` (storage stated, type not).
 *
 * Anything else -- an accessor, an annotated/initialized/JSDoc-typed field, a
 * mixed list pairing an assignment with a real declaration -- means the
 * program DID state something, or another authority already answers it, and
 * this module defers.
 */
const isCandidateSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): boolean => {
  if (inheritedAccessorOfAssignment(checker, symbol)) return false
  const declarations = symbol.declarations
  if (!declarations || declarations.length === 0) return false
  if (declarations.every(isAssignmentDeclaration)) {
    // A SOLE assignment whose own JSDoc tag already states its storage
    // completely defers to the checker's (JSDoc-informed) answer instead of
    // becoming a candidate that could only ever refuse -- see
    // `assignmentStatesCompleteJsDocType`. A multi-declaration symbol (a
    // subclass also writes it) is unaffected: agreeing that ONE declaration
    // is fully stated says nothing about whether the OTHERS are, so this
    // stays conservative and only fires where `statedBoundOfSymbol` and
    // friends already require a sole declaration.
    const sole = declarations.length === 1 ? declarations[0] : undefined
    return sole === undefined || !assignmentStatesCompleteJsDocType(checker, sole)
  }
  const sole = declarations.length === 1 ? declarations[0] : undefined
  if (sole === undefined) return false
  // The third shape: an annotated field whose statement is only an upper
  // bound. Admitted as a candidate here and held to that statement in
  // `resolveSymbol`, which refuses it unless every write narrows the
  // annotation only where the annotation said nothing.
  // The fourth shape: an annotation that names an INTERFACE. See
  // `interfaceAnnotationOfField` for why that is a description of the slot's
  // readers rather than a statement of what it holds.
  return (
    isBareFieldDeclaration(checker, sole) ||
    statedUpperBoundOfField(checker, sole) !== null ||
    interfaceAnnotationOfField(checker, sole) !== null
  )
}

/**
 * Whole-program census of what every unannotated, assignment-only class
 * field holds, once every write to it agrees.
 *
 * `parameters` is the already-settled, composed census this runs on top of
 * (parameters + returns + locals, in whatever order `frontend.ts` composed
 * them) -- asked first at every identifier, exactly as `local-bindings.ts`
 * asks it first. This module never reopens that fixpoint; it only adds what
 * none of those authorities could answer because the chain passed through a
 * field with no declaration of its own.
 */
export const censusFieldBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  /** The same-round array census -- see `return-bindings.ts`'s identical parameter for why, and `frontend.ts`'s `compose`. */
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  /**
   * The whole-program value-flow index -- the ONE walk that states where every
   * write is. This module's own write discovery reads its edges from it rather
   * than re-deriving them; see `flow/model.ts`.
   */
  flow: ValueFlowIndex
): FieldBindingCensus => {
  const bound = new Map<ts.Symbol, ts.Type>()
  /** The synthesized union arms for a field whose writes disagree but disjointly -- see `resolveSymbol`. */
  const unionArms = new Map<ts.Symbol, readonly ts.Type[]>()
  /** The subset of `bound` that came from a STATED annotation -- see `statedTypeAt`. */
  const statedBindings = new Map<ts.Symbol, ts.Type>()
  const refusalOf = new Map<ts.Symbol, string>()
  const resolvingSymbols = new Set<ts.Symbol>()
  /** Whether resolution is in the relaxed retry phase, where a silent write is an absence rather than a veto. See `resolveSymbol`. */
  let lenientPhase = false

  /**
   * Every write this module treats as EVIDENCE about a field's own storage,
   * read from the shared value-flow index rather than re-derived by a private
   * walk of this module's own.
   *
   * This is an EDGE-SOURCE swap, not a policy change. `property-assignment`
   * with a `whole` slot is exactly the `x.field = expr` shape the private walk
   * this replaced looked for, resolved by the identical
   * `checker.getSymbolAtLocation` call at the identical node -- see
   * `FlowTarget`, which records BOTH property-symbol resolutions precisely so
   * a swap like this one cannot silently change which symbol a write lands on.
   *
   * What the swap ADDS is the edges the private walk never had:
   *
   * - `index-assignment` at a `whole` slot -- `o[ 'field' ] = v`, a named
   *   member spelled with brackets. `literalMemberNameOf` already draws this
   *   partition on the READ side in every census here; the write side asked a
   *   narrower question purely because each census wrote its own walk.
   * - `logical-assignment` -- `this.field ??= v`. The slot ends up holding
   *   either its previous contents, which every other write already describes,
   *   or `v`. So `v` is ordinary write evidence, and joining it is the same
   *   rule applied to a write the old walk could not see.
   * - `destructuring-default` -- `({ x: this.a = v } = o)`, the same argument.
   *
   * A write with no VALUE is deliberately excluded: a compound assignment, a
   * `delete`, an iteration binding and a plain destructuring target all state
   * that the slot EXISTS and nothing about what it holds. Admitting them would
   * feed the join a write it cannot type, which this module's own strict phase
   * reads as a veto -- turning a bound field into a refused one, which is the
   * one direction adding evidence must never move.
   */
  const isFieldEvidence = (write: ValueWrite): boolean =>
    write.slot === 'whole' &&
    write.value !== null &&
    (write.edge === 'property-assignment' ||
      (WIDENED && (write.edge === 'index-assignment' || write.edge === 'logical-assignment' || write.edge === 'destructuring-default')))

  /**
   * Every expression written into `symbol`'s storage. For a field with no
   * declaration these are its declarations' own right-hand sides; for a bare
   * `field;` they are the indexed writes. Deduplicated by node, because the
   * two sources overlap exactly on the first shape.
   */
  const writesOf = (symbol: ts.Symbol): readonly ts.Expression[] => {
    const writes = new Set<ts.Expression>()
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isBinaryExpression(declaration)) writes.add(declaration.right)
    }
    for (const write of flow.writesToSymbol(symbol)) if (isFieldEvidence(write) && write.value) writes.add(write.value)
    return [...writes]
  }

  /**
   * The checker's own answer at this node, when it says something usable.
   *
   * `annotationStatesNothing` is part of the test, not just
   * `isUnusableEvidence`, and the difference is the single measured root of
   * the vacuous-receiver family: three.js writes `@type {?Object}` above
   * `this.view = null;`, the checker dutifully types the SYMBOL
   * `Object | null`, and `Object` -- which states nothing about what the
   * value holds -- is not `any`, so it read as real evidence. Worse than
   * slipping through, it DOMINATES a `widestOf` join, because every type is
   * assignable to `Object`: the one vacuous write out-voted the real record
   * the program also wrote, `this.view` answered `Object | null`, and all 23
   * member reads off it boxed. The layout resolver has asked
   * `annotationStatesNothing` of the checker's answer since the two-
   * authorities split it records; this census asking only half the question
   * was drift, now closed.
   */
  const known = (node: ts.Node): ts.Type | null => {
    const type = objectAssignTargetType(checker, node) ?? checker.getTypeAtLocation(node)
    return isUnusableEvidence(type) || annotationStatesNothing(checker, node, type) || isVacuousArrayType(checker, type) ? null : type
  }

  /**
   * `this.bag[k] = v` and `this.bag.p = v`, read as ONE primitive: a bind
   * whose reference's base resolves to `symbol`, with the slot being
   * named or not. Read by `FlowSlotKind` alone -- `member`/`element` -- never
   * by which edge kind produced it, so this stays correct regardless of
   * which syntax (or, per the index's own roadmap, which call whose callee
   * write-through the graph resolves) the write arrives as; `member`/
   * `element` are the two REFERENCE shapes the language actually has, not a
   * list of syntax forms this module enumerates.
   *
   * Evidence, never an answer: `dictionaryShapeOf` below is the one place
   * this becomes a type, and only for the narrow shape it can answer
   * soundly (every shape write UNNAMED). A field that also gets NAMED writes
   * through it needs a real member symbol table to represent, which is a
   * further extension this does not attempt.
   */
  const shapeWritesOf = (symbol: ts.Symbol): readonly ValueWrite[] =>
    flow.writesToSymbol(symbol).filter((write) => (write.slot === 'member' || write.slot === 'element') && write.value !== null)

  /**
   * A field's shape read from writes made THROUGH it elsewhere in the
   * program -- `this.morphTargetDictionary[ name ] = m` reached from a
   * different method than the one that creates `morphTargetDictionary`,
   * three separate times in three unrelated classes (`Line`/`Mesh`/`Points`)
   * -- rather than from an `x.field = expr` write to the field itself.
   * `field-bindings.ts`'s own write-set collection (`writesOf`) only ever
   * looks at writes to the field's OWN whole value; a computed-index write
   * made through it names no member of `field`'s own declaration list at
   * all, so this is genuinely separate evidence, gathered and joined the
   * same way (`known ?? resolveExpr`, then `joinOfWrites`) and refusing on
   * the same terms (silence vetoes in the strict phase, joins what remains
   * once the lenient retry allows it).
   *
   * Deliberately narrow: answered ONLY when every shape write is UNNAMED
   * (`element` slot) -- a plain index signature, `{ [k: string]: V }`, over
   * the join of every value ever written that way. A field that ALSO
   * receives a NAMED (`member`-slot) write refuses here rather than guess at
   * a mixed record-with-index shape; see `dictionaryTypeOf`'s own comment
   * for why building one soundly needs more than this module has today.
   */
  /**
   * `wholeValueTypes` is whatever this symbol's OWN `x.field = expr` writes
   * already typed before this fallback ran (e.g. a real `this.field =
   * undefined;` write elsewhere in the same class) -- evidence this module
   * must not silently drop just because it did not, by itself, settle the
   * field's shape. Folded in only when EVERY one of them is nullish: a
   * genuine non-nullish disagreement (some other write states a real,
   * different shape) is a fact this fallback is not sound to override, so it
   * refuses rather than guess which answer wins.
   */
  const dictionaryShapeOf = (symbol: ts.Symbol, wholeValueTypes: readonly ts.Type[]): ts.Type | null => {
    if (wholeValueTypes.some((type) => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0)) return null
    const writes = shapeWritesOf(symbol)
    if (writes.length === 0 || writes.some((write) => write.slot === 'member')) return null
    const types: ts.Type[] = []
    let silent = 0
    for (const write of writes) {
      const value = write.value as ts.Expression
      const type = known(value) ?? resolveExpr(value)
      if (type) types.push(type)
      else silent += 1
    }
    if (types.length === 0 || (silent > 0 && !lenientPhase)) return null
    const joined = joinOfWrites(checker, types)
    const dictionary = joined ? dictionaryTypeOf(checker, joined) : null
    return dictionary ? withNullish(checker, dictionary, wholeValueTypes) : null
  }

  /** Whether the checker's raw answer at a write is a REAL fact refusing storage (`void`/`never`), as opposed to silence. */
  const statesNoStorage = (node: ts.Node): boolean =>
    (checker.getTypeAtLocation(node).flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0

  /** Node-level memo/cycle-guard for the general resolver below. */
  const nodeMemo = new Map<ts.Node, ts.Type | null>()
  const nodeResolving = new Set<ts.Node>()

  // The closed-family fallback is the parameter census's own rule, asked the
  // same way -- see `flow/class-family-member-read.ts`.
  const propertyTypeOf = (receiver: ts.Type, name: string, at: ts.Node): ts.Type | null =>
    memberTypeOf(checker, receiver, name, at, flow) ?? classFamilyMemberReadTypeOf(checker, flow, receiver, name, parameters)
  /** The member symbol a census-resolved receiver declares under `name` -- the symbol a read through an `any` receiver could not name itself. */
  const memberSymbolOf = (receiver: ts.Type, name: string): ts.Symbol | null =>
    checker.getPropertyOfType(checker.getNonNullableType(receiver), name) ?? null
  /** The expression a literal member was written with -- `{ depth: depthBuffer }` or shorthand `{ depthBuffer }` -- or `null` for any other declaration kind. */
  const literalMemberInitializerOf = (member: ts.Symbol | null): ts.Expression | null => {
    const declaration = member?.valueDeclaration
    if (!declaration) return null
    if (ts.isPropertyAssignment(declaration)) return declaration.initializer
    if (ts.isShorthandPropertyAssignment(declaration)) return declaration.name
    return null
  }
  /**
   * The `value` initializer of an `Object.defineProperty(this, name, { value })`
   * in the receiver class's constructor -- or `null` when no constructor of the
   * class or its bases defines `name` that way.
   *
   * With `checkJs` off the checker declares NO member for a descriptor-defined
   * field, so a read of it names no symbol and `memberSymbolOf` answers
   * nothing; the class LAYOUT, which consumes the define-own-property
   * operation, carries the field natively all the same. Three's `LOD` defines
   * `levels` exactly this way (`define-property-source-transform.ts` lowers
   * the `defineProperties` map to one call per key, binding the receiver and
   * each descriptor to a `const` first), and every `this.levels` read fell to
   * the checker's `any`, so `levels[ i ].hysteresis` reached a `*` as a box.
   * The receiver may be `this` or a `const` alias of it, and the descriptor an
   * object literal or a `const` bound to one: both are the shapes the
   * transform emits.
   */
  const descriptorDefinedInitializerOf = (receiver: ts.Type, name: string): ts.Expression | null => {
    const constInitializerOf = (expression: ts.Expression): ts.Expression | null => {
      if (!ts.isIdentifier(expression)) return null
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
      if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return null
      return declaration.initializer
    }
    const isThisReceiver = (expression: ts.Expression): boolean =>
      expression.kind === ts.SyntaxKind.ThisKeyword || constInitializerOf(expression)?.kind === ts.SyntaxKind.ThisKeyword
    const descriptorLiteralOf = (expression: ts.Expression): ts.ObjectLiteralExpression | null => {
      if (ts.isObjectLiteralExpression(expression)) return expression
      const bound = constInitializerOf(expression)
      return bound && ts.isObjectLiteralExpression(bound) ? bound : null
    }
    const seen = new Set<ts.Type>()
    let current: ts.Type | null = checker.getNonNullableType(receiver)
    while (current && !seen.has(current)) {
      seen.add(current)
      const declaration = current.getSymbol()?.valueDeclaration
      if (!declaration || !ts.isClassLike(declaration)) return null
      const constructor = declaration.members.find(ts.isConstructorDeclaration)
      let found: ts.Expression | null = null
      const visit = (node: ts.Node): void => {
        if (found || ts.isFunctionLike(node)) return
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Object' &&
          node.expression.name.text === 'defineProperty' &&
          node.arguments.length === 3
        ) {
          const [target, key, descriptor] = node.arguments
          if (target && key && descriptor && ts.isStringLiteralLike(key) && key.text === name && isThisReceiver(target)) {
            const literal = descriptorLiteralOf(descriptor)
            const value = literal?.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
                property.name.text === 'value'
            )
            if (value) {
              found = value.initializer
              return
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      if (constructor?.body) visit(constructor.body)
      if (found) return found
      const bases = checker.getBaseTypes(current as ts.InterfaceType)
      current = bases.length === 1 && bases[0] ? bases[0] : null
    }
    return null
  }
  /**
   * The two arms of a NAMED read through a string index signature --
   * `uniforms.dfgLUT` on three's `NativeUniforms = Record<string,
   * NativeUniformSlot>` -- or `null` when the receiver declares the member (or
   * nothing at all).
   *
   * Such a read names no property symbol, so `memberSymbolOf` and
   * `propertyTypeOf` both answered nothing and every `uniforms.X.value = v`
   * store in `WebGLRenderer.setProgram` boxed the slot to write through
   * `reflectSet`. Answering the index signature's value type ALONE is the
   * other failure: `m_uniforms.dfgLUT !== undefined` then folded to `true`
   * and a phong material's uniforms, which have no `dfgLUT`, dereferenced the
   * null slot. The read is the value OR absence, which is the same
   * synthesized-union channel a field's disagreeing write set already
   * publishes through (`unionArmsAt`): a lone dictionary read stays a
   * per-key optional, and the comparison stays a real comparison.
   */
  const indexMemberArmsAt = (node: ts.PropertyAccessExpression): readonly ts.Type[] | null => {
    if (checker.getSymbolAtLocation(node)) return null
    const receiver = receiverTypeOf(node.expression)
    if (!receiver) return null
    const object = checker.getNonNullableType(receiver)
    if ((object.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
    if (checker.getPropertyOfType(object, node.name.text)) return null
    const indexed = checker.getIndexInfoOfType(object, ts.IndexKind.String)?.type
    if (!indexed || (indexed.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
    // Flat, like every other arm list this channel publishes: a declared
    // `Array<...> | undefined` value contributes its own members, and the
    // read's absence is the one `undefined` arm.
    const members = indexed.isUnion() ? indexed.types : [indexed]
    const present = members.filter((member) => (member.flags & ts.TypeFlags.Undefined) === 0)
    return present.length === 0 ? null : [...present, checker.getUndefinedType()]
  }
  /** The census's type for a receiver expression: its resolved type, or the PRESENT arm of an index-signature read the union channel answers -- absence is the read's own guard, not the member lookup's. */
  const receiverTypeOf = (expression: ts.Expression): ts.Type | null => {
    const resolved = knownOrResolve(expression)
    if (resolved) return resolved
    const unwrapped = unwrapParens(expression)
    if (!ts.isPropertyAccessExpression(unwrapped)) return null
    const arms = indexMemberArmsAt(unwrapped)
    return arms?.find((arm) => (arm.flags & ts.TypeFlags.Undefined) === 0) ?? null
  }
  /** `getSymbolAtLocation` for a member read, falling back to the census-resolved receiver's own member when the checker names none. */
  const memberSymbolAt = (node: ts.PropertyAccessExpression): ts.Symbol | null => {
    const named = checker.getSymbolAtLocation(node)
    if (named) return named
    const receiver = knownOrResolve(node.expression)
    return receiver ? memberSymbolOf(receiver, node.name.text) : null
  }

  const attribute = (symbol: ts.Symbol, reason: string): null => {
    if (!refusalOf.has(symbol)) refusalOf.set(symbol, reason)
    return null
  }

  /**
   * `symbol`'s own resolved type -- the join of every write to it -- or
   * `null` when this module refuses it. Memoized in `bound`; cycle-guarded
   * by `resolvingSymbols` so a field whose write reads itself (or another
   * field/cell whose write reads this one) refuses instead of looping.
   */
  const resolveSymbol = (symbol: ts.Symbol): ts.Type | null => {
    const already = bound.get(symbol)
    if (already) return already
    if (unionArms.has(symbol)) return null
    if (!isCandidateSymbol(checker, symbol)) return null
    if (refusalOf.has(symbol)) return null
    if (resolvingSymbols.has(symbol)) return null
    resolvingSymbols.add(symbol)
    const stated = statedBoundOfSymbol(checker, symbol)
    let result: ts.Type | null = null
    const writes = writesOf(symbol)
    const types: ts.Type[] = []
    let silent = 0
    let refused: string | null = null
    for (const write of writes) {
      // A STATED CELL THE UPSTREAM CENSUS NARROWED OUTRANKS THE CHECKER at
      // this write. `known` asks the checker first everywhere else, which is
      // right when the checker's answer is the last word about the value --
      // and wrong for exactly the value whose own cell was narrowed WITHIN a
      // statement the checker still reports in full. hono's
      // `this.#matchResult = matchResult` is the measured case: the parameter
      // census already bound `matchResult` to the concrete
      // `Result<[H, RouterRoute]>` its only caller passes, while the checker
      // keeps answering the annotation's `Result<[unknown, RouterRoute]>`, so
      // reading the checker here typed the FIELD as the upper bound and left
      // the store between two disagreeing carriers -- the same
      // two-authorities split every census here exists to close, one hop
      // downstream. `statedTypeAt` answers only where such a narrowing was
      // admitted, so this changes nothing anywhere else.
      // An EMPTY literal the program writes is a fresh object with zero
      // members, not the vacuous `{}` annotation `known` rightly discards --
      // the same holder `parameter-bindings.ts`/`local-bindings.ts` already
      // read it as (`exactEmptyObjectLiteralType`). three's
      // `/** @type {Object} */ this.userData = {};` is the measured case:
      // with that write silent, every class's `userData` fell back to the
      // annotation's `any` and boxed the empty object it only ever holds.
      const type = parameters.statedTypeAt(write) ?? exactEmptyObjectLiteralType(checker, write) ?? known(write) ?? resolveExpr(write)
      if (type) types.push(type)
      // A write typed `void`/`never` is a real fact stating the storage holds
      // nothing a program can use -- a veto in both phases, exactly as
      // `parameter-bindings.ts` keeps `call-passes-no-argument` firing in its
      // own relaxed phase. Only a write nobody could type at all is SILENCE.
      else if (statesNoStorage(write)) {
        refused = 'write-states-no-storage'
        break
      } else silent += 1
    }
    // A bare `field;` nothing ever writes says nothing about its storage --
    // distinct from a disagreement, and left exactly as the checker has it.
    if (writes.length === 0) attribute(symbol, 'no-writes')
    else if (refused) attribute(symbol, refused)
    // EVIDENCE EXHAUSTED -- the same rule, the same order, as
    // `parameter-bindings.ts`'s `skipSilentSites` phase: a write that states
    // nothing is not a write that disagrees. In the strict phase one silent
    // write still refuses the whole field; the relaxed retry (below, run only
    // over fields the strict pass could not bind) joins the writes that DO
    // speak. `writes-disagree` still fires over what remains, and a field
    // whose every write is silent refuses exactly as before. Measured shape:
    // `Vector3`'s `x`/`y`/`z` carry 34 writes each, 33 typed `number` and one
    // (`this.x = e[ 12 ]`, `e` unannotated) silent -- 759 reads boxed by a
    // veto that read no fact.
    else if (silent > 0 && (!lenientPhase || types.length === 0)) attribute(symbol, 'write-unresolved')
    else {
      const joined = joinOfWrites(checker, types)
      if (joined) result = joined
      else {
        // The join found no single covering type. Before refusing, ask
        // whether the disagreement is itself a sound answer -- see
        // `disjointUnionMembersOf`'s own comment for what "sound" means.
        const arms = disjointUnionMembersOf(checker, types)
        if (arms) unionArms.set(symbol, arms)
        else attribute(symbol, 'writes-disagree')
      }
    }
    // A field's OWN writes settled on NOTHING -- no `x.field = expr` at all,
    // or every one silent. Before leaving it there, ask whether the program
    // instead writes THROUGH it: `dictionaryShapeOf` reads exactly that,
    // uniformly by slot rather than by syntax (see its own comment). Tried
    // only here, as a fallback -- a field whose own writes already answered
    // something (bound, union-armed, or refused for a REAL reason such as
    // `write-states-no-storage`/`writes-disagree`) keeps that answer.
    // A STATED field is held to its statement, exactly as
    // `parameter-bindings.ts` holds a stated parameter to its own: the join
    // has to be assignable to the annotation (the floor -- a write the
    // annotation forbids is not what this field holds, whatever the writes
    // say) AND to differ from it only where the annotation said nothing. A
    // synthesized disjoint union is refused outright: those arms are a member
    // LIST for `table.intern`, never a `ts.Type` the statement can be tested
    // against, so there is nothing to hold it to.
    // See `interfaceAnnotationOfField`: an `interface` annotation describes a
    // slot's readers, never its storage, so a join that settles on ONE CLASS
    // satisfying it is what the slot holds -- including where the annotation
    // ALSO left a position unstated, which is the ordinary case for a generic
    // interface and would otherwise be refused below as narrowing a stated
    // position (the class is a different nominal type, not a filled hole).
    const declaredInterface = interfaceBoundOfSymbol(checker, symbol)
    const classSatisfiesInterface =
      declaredInterface !== null &&
      result !== null &&
      !unionArms.has(symbol) &&
      isClassInstanceType(result) &&
      checker.isTypeAssignableTo(result, declaredInterface)
    if (declaredInterface !== null && !classSatisfiesInterface && !stated) {
      if (unionArms.has(symbol)) {
        unionArms.delete(symbol)
        attribute(symbol, 'interface-field-synthesized-union')
      } else if (result) {
        result = null
        attribute(symbol, 'interface-field-write-is-not-a-satisfying-class')
      }
    }
    if (classSatisfiesInterface && result) statedBindings.set(symbol, result)
    if (stated && !classSatisfiesInterface) {
      if (unionArms.has(symbol)) {
        unionArms.delete(symbol)
        attribute(symbol, 'stated-field-synthesized-union')
      } else if (result && carriesUnsubstitutedGeneric(checker, result)) {
        result = null
        attribute(symbol, 'stated-field-open-generic')
      } else if (result && !checker.isTypeAssignableTo(result, stated.bound)) {
        result = null
        attribute(symbol, 'stated-field-write-not-assignable')
      } else if (result && !narrowsOnlyUnstatedPositions(checker, stated.declaration, stated.bound, result)) {
        result = null
        attribute(symbol, 'stated-field-narrows-a-stated-position')
      }
      if (result) statedBindings.set(symbol, result)
    }
    // A stated field takes no dictionary fallback: the program described the
    // storage, so "the program writes THROUGH it" is not a reading of an
    // absence any more -- it is a second opinion about a slot that already
    // has one.
    if (!result && !stated && !unionArms.has(symbol)) {
      const reason = refusalOf.get(symbol)
      if (reason === 'no-writes' || reason === 'write-unresolved') {
        const shape = dictionaryShapeOf(symbol, types)
        if (shape) {
          result = shape
          refusalOf.delete(symbol)
        }
      }
    }
    resolvingSymbols.delete(symbol)
    if (result) bound.set(symbol, result)
    return result
  }

  const unwrapParens = (node: ts.Expression): ts.Expression => {
    let current: ts.Expression = node
    while (ts.isParenthesizedExpression(current)) current = current.expression
    return current
  }

  /** Preserve upstream receiver evidence before deriving a field answer. Casts remain explicit boundaries. */
  const knownOrResolve = (node: ts.Expression): ts.Type | null => {
    const unwrapped = unwrapParens(node)
    if (ts.isAsExpression(unwrapped) || ts.isTypeAssertionExpression(unwrapped)) return known(unwrapped)
    return known(node) ?? parameters.typeAt(node) ?? resolveExpr(node)
  }

  /**
   * The general walk. A property access checks whether ITS OWN symbol is a
   * field candidate first -- a write's left-hand side and a read are the
   * SAME symbol, so both answer from the SAME `resolveSymbol` computation --
   * and only falls to the ordinary receiver-typed property lookup when it is
   * not. Every other node kind recurses through the SAME upstream-first rule
   * at its own operands, so a chain like `this.view.enabled` resolves once
   * `view` does, regardless of which layer actually answered it.
   */
  const compute = (node: ts.Node): ts.Type | null => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return knownOrResolve(node.expression)
    }
    // A bare `field;` declaration is a node a downstream producer can publish
    // a carrier from, so it MUST answer identically to every read of the same
    // slot -- both from this one `resolveSymbol` computation. Answering reads
    // while leaving the declaration to the checker's `any` is precisely the
    // two-authorities-on-one-storage-location split that manufactures
    // `binding-read-conversion` obligations; see `local-bindings.ts`'s header,
    // which mirrors this hop for a `VariableDeclaration`.
    if (ts.isPropertyDeclaration(node)) {
      const declared = checker.getSymbolAtLocation(node.name)
      return declared ? resolveSymbol(declared) : null
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      if (symbol && isCandidateSymbol(checker, symbol)) return resolveSymbol(symbol)
      const receiver = receiverTypeOf(node.expression)
      if (!receiver) return null
      // A named read through an index signature is answered as a union by
      // `unionArmsAt` (see `indexMemberArmsAt`); a single type here would
      // state presence the receiver never declared.
      if (indexMemberArmsAt(node)) return null
      // An `any` receiver names no symbol,
      // so the checker cannot say which field this read names -- but the
      // census just resolved the receiver, and THAT type does. Look the member
      // up on it and answer from this census's own write-set join, exactly as
      // a read the checker could attribute is answered above. Without this
      // hop the read fell to `propertyTypeOf`, which reads the checker's
      // `any` for the field and refuses, so the census had typed the field
      // AND the receiver and still boxed the read between them: three's
      // `WebGLShadowMap( renderer, ... )` binds `renderer` from its one call
      // site, `renderer.state` resolved to the typed struct field in the
      // emitted C++, and `const _state = renderer.state` was laid out
      // `gea::Value` from the checker's `any` -- every `_state.setBlending()`
      // then went through dynamic lookup and threw on the first frame.
      const member = symbol ? null : memberSymbolOf(receiver, node.name.text)
      if (member && isCandidateSymbol(checker, member)) return resolveSymbol(member)
      const typed = propertyTypeOf(receiver, node.name.text, node)
      if (typed) return typed
      // An OBJECT-LITERAL member the checker types `any` still has the one
      // expression that filled it. Three's `WebGLState` returns
      // `{ buffers: { depth: depthBuffer, ... } }` where `depthBuffer` is
      // `new DepthBuffer()` -- `new` on a JS factory with no construct
      // signature, `any` to the checker, a typed record to this census (the
      // parameter census reads the factory's return). The literal's LAYOUT was
      // already derived from that initializer, so the struct carries `depth`
      // natively; a READ answered `null` here instead, and the emitter then
      // boxed the native callable field to call it dynamically -- which threw
      // on the first frame of the app's shadow pass. Answer the read from the
      // same initializer the layout came from.
      const filled =
        literalMemberInitializerOf(member ?? memberSymbolOf(receiver, node.name.text)) ??
        descriptorDefinedInitializerOf(receiver, node.name.text)
      return filled ? knownOrResolve(filled) : null
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const receiver = knownOrResolve(node.expression)
      if (!receiver) return collections.arrayElementForRead(node.expression)
      // A literal key is a named member spelled with brackets; any other key
      // is answered by the receiver's index signature, and by nothing else.
      const name = literalMemberNameOf(node)
      if (name !== null) return propertyTypeOf(receiver, name, node)
      const key = knownOrResolve(node.argumentExpression)
      if (!key) return null
      // See `return-bindings.ts`'s identical fallback: a resolved receiver
      // with no index signature of its own is still answerable from the
      // array census's own push/write evidence.
      return indexedTypeOf(checker, receiver, key, node, flow, parameters) ?? collections.arrayElementForRead(node.expression)
    }
    if (ts.isIdentifier(node)) return parameters.typeAt(node)
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const upstream = parameters.typeAt(node)
      if (upstream) return upstream
      const invariant = overloadInvariantReturnTypeAt(checker, node, knownOrResolve)
      if (invariant) return invariant
      const callee = knownOrResolve(node.expression)
      if (!callee) return null
      const constructed = ts.isNewExpression(node) ? callee.getConstructSignatures() : []
      const signatures = constructed.length > 0 ? constructed : callee.getCallSignatures()
      if (signatures.length !== 1) return null
      const signature = signatures[0] as ts.Signature
      const unwrapped = ts.isCallExpression(node) ? unwrapExplicitThisCall(checker, node) : null
      const returned = explicitThisCallReturnType(signature, unwrapped ? knownOrResolve(unwrapped.callee) : null)
      if ((returned.flags & (ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) return null
      return isAnyType(returned) ? null : returned
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return knownOrResolve(node.right)
    if (ts.isConditionalExpression(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      return derivedExpressionType(checker, node, (operand) => knownOrResolve(operand))
    }
    return null
  }

  const resolveExpr = (node: ts.Node): ts.Type | null => {
    const cached = nodeMemo.get(node)
    if (cached !== undefined) return cached
    if (nodeResolving.has(node)) return null
    nodeResolving.add(node)
    const answer = compute(node)
    nodeResolving.delete(node)
    nodeMemo.set(node, answer)
    return answer
  }

  // Enumerate every candidate SYMBOL up front, from every `x.field = expr`
  // write's left-hand side, so `boundCount`/`refusals` reflect the whole
  // program rather than only the nodes some other pass happened to query.
  const candidateSymbols = new Set<ts.Symbol>()
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left)
      if (symbol && isCandidateSymbol(checker, symbol)) candidateSymbols.add(symbol)
    }
    // A bare `field;` is a candidate whether or not anything writes it -- one
    // nothing writes must be REFUSED rather than absent, or `refusals` stops
    // describing the program.
    if (ts.isPropertyDeclaration(node)) {
      const declared = checker.getSymbolAtLocation(node.name)
      if (declared && isCandidateSymbol(checker, declared)) candidateSymbols.add(declared)
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) forEachReachableStatement(reachable, file, visit)
  for (const symbol of candidateSymbols) resolveSymbol(symbol)
  // The relaxed phase, run only once the strict pass has settled -- so every
  // field the strict rule can bind is bound from ALL its writes before any
  // field is bound from a subset. Rounds repeat because a field bound from
  // surviving evidence is itself evidence for another field's writes; the
  // node memo is cleared each round because its cached nulls are answers to
  // the smaller view. Terminates because bindings are only ever added.
  lenientPhase = true
  for (;;) {
    const retry = [...candidateSymbols].filter((symbol) => !bound.has(symbol) && refusalOf.get(symbol) === 'write-unresolved')
    if (retry.length === 0) break
    for (const symbol of retry) refusalOf.delete(symbol)
    nodeMemo.clear()
    const before = bound.size
    for (const symbol of retry) resolveSymbol(symbol)
    if (bound.size === before) break
  }

  /**
   * A refusal's `owner` for a field SYMBOL: its own name and where the
   * program first declares/writes it -- the same rendering
   * `local-bindings.ts`'s `ownerOfDeclaration` uses for a `VariableDeclaration`,
   * asked of a symbol whose "declaration" is often a bare `x.field = expr`
   * assignment rather than a real declaration node, which is why the name
   * comes from `checker.symbolToString` (works for either shape) rather than
   * from a `.name` a `BinaryExpression` declaration does not have.
   */
  const ownerOfSymbol = (symbol: ts.Symbol): string => {
    const declaration = symbol.declarations?.[0]
    if (!declaration) return checker.symbolToString(symbol)
    const file = declaration.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1
    return `${checker.symbolToString(symbol)} (${file.fileName}:${line})`
  }

  // `root` is the same stable, hand-written reason string this census always
  // keyed its old count map by (`no-writes`, `write-unresolved`,
  // `writes-disagree`, one of the `stated-field-*`/`interface-field-*`
  // family, ...) -- never node text or a type spelling, so it is already the
  // ROOT `census-refusal.ts` asks for. `owner` is the new fact: the symbol's
  // own name and source location, the one thing a count could never say.
  const refusals: CensusRefusal[] = []
  for (const symbol of candidateSymbols) {
    if (bound.has(symbol) || unionArms.has(symbol)) continue
    const root = refusalOf.get(symbol) ?? 'unresolved'
    refusals.push(censusRefusal('field', root, root, ownerOfSymbol(symbol)))
  }

  /** The union-arms mirror of `compute`'s two symbol-resolving node shapes -- a leaf lookup, not a walk: a synthesized union is never itself an operand another expression resolves through. */
  const unionArmsAt = (node: ts.Node): readonly ts.Type[] | null => {
    if (ts.isPropertyDeclaration(node)) {
      const declared = checker.getSymbolAtLocation(node.name)
      return declared ? (unionArms.get(declared) ?? null) : null
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = memberSymbolAt(node)
      if (symbol) return unionArms.get(symbol) ?? null
      return indexMemberArmsAt(node)
    }
    return null
  }

  /** The `unionArmsAt` shape asked of `statedBindings` -- the same two symbol-resolving node kinds, a leaf lookup rather than a walk. */
  const statedTypeAt = (node: ts.Node): ts.Type | null => {
    if (statedBindings.size === 0) return null
    const symbol = ts.isPropertyDeclaration(node)
      ? checker.getSymbolAtLocation(node.name)
      : ts.isPropertyAccessExpression(node)
        ? memberSymbolAt(node)
        : ts.isElementAccessExpression(node)
          ? checker.getSymbolAtLocation(node)
          : undefined
    return symbol ? (statedBindings.get(symbol) ?? null) : null
  }

  return {
    typeAt: (node) => resolveExpr(node),
    unionArmsAt,
    statedTypeAt,
    boundCount: bound.size + unionArms.size,
    refusals,
    refusalOf: (symbol) => refusalOf.get(symbol) ?? null
  }
}

/**
 * A `ParameterBindingCensus`-shaped view answering from BOTH: `parameters`'s
 * own answer first, this census's otherwise -- composed exactly as
 * `local-bindings.ts`'s own `withLocalBindings` is, and meant to sit
 * immediately after it in `frontend.ts`:
 *
 *   const parameters = withFieldBindings(checker, files, withLocalBindings(checker, files, withReturnBindings(...)))
 */
export const withFieldBindings = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  parameters: ParameterBindingCensus,
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  flow: ValueFlowIndex
): ParameterBindingCensus => {
  const fields = censusFieldBindings(checker, files, reachable, parameters, collections, flow)
  // `ParameterBindingCensus.refusals` is itself a `readonly CensusRefusal[]`
  // now (`parameter-bindings.ts`'s own conversion), so composing the two
  // lists is a plain concatenation -- no reason-string prefixing, no count
  // merge, and nothing to disagree about. `censusRefusal('field', ...)`
  // already namespaces every key as `census:field:<root>`, distinct from
  // `parameters`' own `census:parameter:<root>`/`census:local:<root>`/etc.
  // keys by construction, so nothing here can collide the way the old
  // `field:${reason}` string concatenation existed to prevent.
  const refusals: readonly CensusRefusal[] = [...parameters.refusals, ...fields.refusals]
  return {
    ...parameters,
    typeAt: (node) => parameters.typeAt(node) ?? fields.typeAt(node),
    statedTypeAt: (node) => parameters.statedTypeAt(node) ?? fields.statedTypeAt(node),
    unionArmsAt: (node) => parameters.unionArmsAt(node) ?? fields.unionArmsAt(node),
    boundCount: parameters.boundCount + fields.boundCount,
    refusals
  }
}
