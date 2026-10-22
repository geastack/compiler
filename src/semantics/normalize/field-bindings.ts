import ts from '#typescript'
import { inheritedAccessorOfAssignment } from '../inherited-accessor.js'
import {
  annotationStatesNothing,
  containsUnstatedPosition,
  derivedExpressionType,
  disjointUnionMembersOf,
  exactEmptyObjectLiteralType,
  indexedTypeOf,
  isGlobalObjectConstructor,
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
import { createCensusComputedKeysOf, type CensusComputedKeysOf } from './host-mutation-computed-keys.js'
import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import { argumentsObjectUsesAt } from './arguments-objects.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'
import { forEachReachableStatement, nodeIsReachable, type ProgramReachability } from './reachability.js'
import { censusRefusal, type CensusRefusal } from './census-refusal.js'
import { NullableMemo } from './nullable-memo.js'
import { readsStatedDynamicValue } from './stated-dynamic-value.js'

/**
 * The type an unannotated class FIELD holds, when the program never declares
 * it and only ever assigns it -- `this.view = null;` in a class's
 * constructor, reassigned a real object later in some `setView` method. TypeScript's
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
 * `class Shape { aspect; }` -- a `PropertyDeclaration` with no annotation,
 * no initializer and no JSDoc tag -- states that the storage EXISTS and
 * nothing whatever about what it holds; the checker's own answer for it is
 * `any`. The original rule turned every `PropertyDeclaration` away on the
 * reasoning that "TypeScript already reads an unannotated field
 * declaration's own initializer", which is true of `aspect = 1;` and vacuous
 * for `aspect;`: there is no initializer to read, so nothing reads anything
 * and every `shape.aspect` boxes.
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
  /** How many unstated fields this census widened to `any` because a write stores a value nothing types -- see `widenDynamicallyWrittenFields`. */
  readonly widenedCount: number
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
  widenedCount: 0,
  refusals: [],
  refusalOf: () => null
}

const WIDENED = process.env['GEA_FLOW_WIDE'] === '1'
const WIDEN_DEBUG = process.env['GEA_WIDEN_DEBUG'] === '1'

const isAnyType = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.Any) !== 0

const isNullish = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0

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
 * A JSDoc field `@type {Array<Object>}` is the measured case,
 * where the global `Object` INTERFACE is collapsed to `any` by
 * `structural.ts`'s `isGlobalObjectInterface` for the same reason
 * `annotationStatesNothing` refuses it bare -- so the annotation arrives here
 * as `any[]`, read as REAL evidence, and the field's write set (which the
 * program plainly fills with real records) was never consulted at all.
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

interface SymbolConstructingChecker {
  createSymbol(flags: ts.SymbolFlags, name: ts.__String): ts.Symbol & { links: { type?: ts.Type } }
  getUnionType(types: readonly ts.Type[]): ts.Type
}
const optionalRecords = new WeakMap<ts.TypeChecker, Map<ts.Type, ts.Type>>()
/**
 * `record` with every member optional, or `null` unless `record` is a plain
 * object record (no signatures, no index, not a class or array). The members
 * keep their declarations, so the layout still names where each was written.
 */
const recordWithOptionalMembersOf = (checker: ts.TypeChecker, record: ts.Type): ts.Type | null => {
  if (!(record.flags & ts.TypeFlags.Object) || record.isClass() || checker.isArrayType(record) || checker.isTupleType(record)) return null
  if ((record.getSymbol()?.flags ?? 0) & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) return null
  if (record.getCallSignatures().length || record.getConstructSignatures().length || checker.getIndexInfosOfType(record).length) return null
  const properties = checker.getPropertiesOfType(record)
  if (properties.length === 0) return null
  if (properties.some((property) => property.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor))) return null
  const cached = optionalRecords.get(checker)?.get(record)
  if (cached) return cached
  const constructing = checker as unknown as Partial<SymbolConstructingChecker & DictionaryConstructingChecker>
  if (
    typeof constructing.createSymbol !== 'function' ||
    typeof constructing.getUnionType !== 'function' ||
    typeof constructing.createAnonymousType !== 'function'
  )
    return null
  const members = new Map<ts.__String, ts.Symbol>()
  for (const property of properties) {
    const optional = constructing.createSymbol(ts.SymbolFlags.Property | ts.SymbolFlags.Optional, property.escapedName)
    optional.links.type = constructing.getUnionType([checker.getTypeOfSymbol(property), checker.getUndefinedType()])
    if (property.declarations) optional.declarations = property.declarations
    if (property.valueDeclaration) optional.valueDeclaration = property.valueDeclaration
    members.set(property.escapedName, optional)
  }
  const answer = constructing.createAnonymousType(undefined, members as ts.SymbolTable, [], [], [])
  let cache = optionalRecords.get(checker)
  if (!cache) optionalRecords.set(checker, (cache = new Map()))
  cache.set(record, answer)
  return answer
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
 * A class whose constructor stores a partly-unstated parameter into a field
 * of the same annotation is the measured case, and it is why this exists at
 * all. A constructor parameter `matchResult: Result<[unknown, Route]>` is
 * already narrowed to the concrete `Result<[H, Route]>` its only caller
 * passes, by exactly the parameter rule above. The FIELD it is stored into,
 * `#matchResult: Result<[unknown, Route]>`, kept the annotation -- so
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
  if (ts.isPropertySignature(declaration)) return statedCallableResultBoundOfSignature(checker, declaration)
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
 * A type-literal or interface MEMBER stated as a function whose only unstated
 * position is its RESULT -- the one shape of `PropertySignature` admitted as
 * an upper bound.
 *
 * The measured case: an interface member `parse` stated
 * `(bytes: Uint8Array, startOffset?: number) => Iterable<Element>` whose
 * one writer, `api.parse = parse`, is a function the
 * return census already narrowed to the `Element[]` it builds. Held to the
 * statement, the member carried a callable returning the `Iterable` protocol
 * record while the value stored into it returned an array: the store needed a
 * callable conversion no backend has, and a consumer's
 * `Array.isArray(res) ? res : [...res]` would have seen a protocol view where
 * node sees the array.
 *
 * Deliberately narrow. A signature member can also be written by an object
 * literal the flow index attributes to the literal's own property, not to
 * this member, so the join here may miss a writer. Only the RESULT may be
 * open, because a missed writer then meets a narrowed callable at a store
 * the conversion algebra refuses (fail closed) -- whereas narrowing an open
 * PARAMETER would let callers that pass the stated wider type reach a body
 * typed narrower.
 */
const statedCallableResultBoundOfSignature = (checker: ts.TypeChecker, declaration: ts.PropertySignature): ts.Type | null => {
  const node = declaration.type
  if (!node || !ts.isFunctionTypeNode(node) || declaration.questionToken) return null
  if (declaration.getSourceFile().isDeclarationFile || isAmbientDeclaration(declaration)) return null
  for (const parameter of node.parameters) {
    if (!parameter.type) return null
    if (containsUnstatedPosition(checker, parameter.type, checker.getTypeFromTypeNode(parameter.type))) return null
  }
  if (!containsUnstatedPosition(checker, node.type, checker.getTypeFromTypeNode(node.type))) return null
  return checker.getTypeFromTypeNode(node)
}

/**
 * Whether `actual` -- the join of a field's writes -- differs from its stated
 * upper bound only where the statement said nothing.
 *
 * For a callable member (`statedCallableResultBoundOfSignature`) the value
 * test `narrowsOnlyUnstatedPositions` is the wrong instrument at the
 * PARAMETERS: a writer `(bytes, startOffset: number | null = 0)`
 * under a member stated `startOffset?: number`, which is not the same type
 * but is exactly what the floor (`isTypeAssignableTo`, asked by the caller)
 * already proves safe -- the writer accepts every argument a caller of the
 * statement can pass, and the member carries the writer's own convention, so
 * the call converts each argument into it. Only the RESULT is held to the
 * unstated-position rule.
 */
const statedFieldAdmits = (checker: ts.TypeChecker, declaration: ts.Declaration, bound: ts.Type, actual: ts.Type): boolean => {
  if (!ts.isPropertySignature(declaration)) return narrowsOnlyUnstatedPositions(checker, declaration, bound, actual)
  const node = declaration.type
  const stated = bound.getCallSignatures()
  const written = actual.getCallSignatures()
  if (!node || !ts.isFunctionTypeNode(node) || stated.length !== 1 || written.length !== 1) return false
  if (actual.getConstructSignatures().length > 0) return false
  const statedResult = stated[0]!.getReturnType()
  return narrowsOnlyUnstatedPositions(checker, node.type, statedResult, written[0]!.getReturnType())
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
 * The measured case is not a boxing question, it is a CORRECTNESS one: a
 * field `router` annotated `Router<[H, Route]>`, an interface whose members
 * are `name`, `add` and `match`, written by the constructor as
 * `new SimpleRouter()` and by nothing else. Carried as the
 * interface, the field became a struct with two `gea::CallableObject` members
 * that nothing could fill (a class's methods are free functions taking the
 * instance, not storage), the class instance would not assign into it at all,
 * and -- worse than either -- the class's `add`/`match` were never reached
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
 * symbol's type: `/** @type {Array<Shape>} *\/ this.shapes =
 * [];` types the SYMBOL `Shape[]`, in full, from the tag alone. A
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
 * checker-backed lookup that would have read the JSDoc-informed `Shape[]`
 * directly. So a field the program fully described boxed every read of it,
 * for want of a check a sibling shape (`isBareFieldDeclaration`) already
 * makes for the OTHER declaration kind. Measured shape: JavaScript class
 * fields each written once as an empty literal the evolving-array checker calls `never[]`
 * (correctly silent as evidence -- see `resolveSymbol`'s `write-unresolved`)
 * and annotated `Array<Shape>` directly above that one
 * write: fully concrete container types the program already committed to,
 * refused here for want of ever reading the annotation.
 *
 * Deliberately narrower than "any JSDoc-typed assignment": `Array<Object>`
 * (same shape, same single silent write) has an UNSTATED position (`Object`
 * states nothing on its own,
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
  /**
   * `statedBindings` again, keyed by each declaration of the bound symbol. A
   * read through a receiver typed as the class INSTANCE (`source.
   * groups` off a `@type {Shape}` cast) can resolve to the
   * instance type's own property symbol rather than the one the writes
   * declared; both name the same declarations, and the cell and its reads
   * must not split.
   */
  const statedByDeclaration = new Map<ts.Node, ts.Type>()
  const state = (symbol: ts.Symbol, type: ts.Type): void => {
    statedBindings.set(symbol, type)
    for (const declaration of symbol.declarations ?? []) statedByDeclaration.set(declaration, type)
  }
  const refusalOf = new Map<ts.Symbol, string>()
  /** A fresh `{}` written into a field bound by `recordWithOptionalMembersOf`, and that field's type. */
  const freshEmptyHomes = new Map<ts.Node, ts.Type>()
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
   * `this[ key ] = v` where `key` is PROVEN to range over a finite set of
   * names (`flow/computed-key-set.ts`) writes `v` into the field each of those
   * names spells -- exactly as `this.settings = v` would. A base-class
   * `setValues( values )` that copies an options bag onto `this` by key is
   * the measured shape: without this the field census saw only
   * `this.settings = {}`, typed the subclass's `settings` as the empty
   * record, and the store landed in a document view the program's later
   * `for ( name in this.settings )` could not see --
   * `0` where Node prints `3.5`, with a clean exit.
   *
   * The written value is typed PER NAME where it is the very `values[ key ]`
   * the key enumerates (directly or through a `const` binding of it): under
   * key `settings` the value is `values.settings`, not the join of every
   * option the bag carries -- the same type a static `this.settings =
   * values.settings` would contribute. Any other value joins whole.
   *
   * The key set is an UPPER bound; a name outside it never reaches a field
   * here. Its intrinsic assumptions (`Object.keys`, the Array iteration
   * protocol, and for a `for-in` key an `Object.prototype` that carries no
   * enumerable key) cannot be discharged before the host-mutation census
   * seals, so a field typed from the store publishes them as ledger
   * obligations rather than taking them as given.
   *
   * A store whose key set is NOT proven, into a receiver that may be an
   * instance of a class, may write any string-named field of that class's
   * family: it is a write to each of them (a silent one where its value
   * cannot be typed), never no write at all. A receiver union names each of
   * its class arms.
   */
  interface KeyedStore {
    readonly owner: ts.ClassLikeDeclaration
    readonly key: ts.Expression
    readonly value: ts.Expression
    readonly requirements: readonly IntrinsicProtocolRequirement[]
    /** For an unproven key: whether it can spell only canonical numeric names. */
    readonly numericOnly?: boolean
  }
  const instanceClassesOf = (node: ts.Expression): readonly ts.ClassLikeDeclaration[] => {
    const typed = checker.getTypeAtLocation(node)
    const type = isAnyType(typed) ? parameters.typeAt(node) : typed
    if (!type) return []
    const classes = new Set<ts.ClassLikeDeclaration>()
    for (const arm of type.isUnion() ? type.types : [type]) {
      const symbol = arm.getSymbol() ?? checker.getApparentType(arm).getSymbol()
      const declaration = symbol?.declarations?.find(ts.isClassLike)
      if (declaration) classes.add(declaration)
    }
    return [...classes]
  }
  /** The names an unproven key can spell: none (symbols only), canonical numeric ones only, or any. */
  const unprovenKeyDomainOf = (key: ts.Expression): 'none' | 'numeric' | 'any' => {
    const type = checker.getTypeAtLocation(key)
    const arms = (type.isUnion() ? type.types : [type]).filter(
      (arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0
    )
    if (arms.length > 0 && arms.every((arm) => (arm.flags & ts.TypeFlags.ESSymbolLike) !== 0)) return 'none'
    if (arms.length > 0 && arms.every((arm) => (arm.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.ESSymbolLike)) !== 0)) return 'numeric'
    return 'any'
  }
  let keyedStores: { readonly named: Map<string, KeyedStore[]>; readonly unproven: KeyedStore[] } | undefined
  const keyedStoresNamed = (name: string): readonly KeyedStore[] => {
    if (!keyedStores) {
      keyedStores = { named: new Map(), unproven: [] }
      const typeOf = (expression: ts.Expression): ts.Type => {
        const own = checker.getTypeAtLocation(expression)
        return isAnyType(own) ? (parameters.typeAt(expression) ?? own) : own
      }
      let keysOf: CensusComputedKeysOf | undefined
      for (const write of flow.allWrites) {
        const access = write.propertyAccess
        if (write.edge !== 'index-assignment' || !write.value || !access || !ts.isElementAccessExpression(access)) continue
        if (literalMemberNameOf(access) !== null) continue
        const owners = instanceClassesOf(access.expression)
        if (owners.length === 0) continue
        keysOf ??= createCensusComputedKeysOf(
          checker,
          flow,
          closedCallableAuthorityOf(checker, flow, typeOf, (callable) => argumentsObjectUsesAt(checker, callable))
        )
        const proven = keysOf(access.argumentExpression)
        if (proven === null) {
          const domain = unprovenKeyDomainOf(access.argumentExpression)
          if (domain === 'none') continue
          for (const owner of owners)
            keyedStores.unproven.push({
              owner,
              key: access.argumentExpression,
              value: write.value,
              requirements: [],
              numericOnly: domain === 'numeric'
            })
          continue
        }
        const requirements = proven.inheritsObjectPrototypeKeys
          ? [...proven.requirements, { intrinsic: 'Object' as const, location: access.argumentExpression }]
          : proven.requirements
        for (const key of proven.keys) {
          const stores = keyedStores.named.get(key) ?? []
          for (const owner of owners) stores.push({ owner, key: access.argumentExpression, value: write.value, requirements })
          keyedStores.named.set(key, stores)
        }
      }
    }
    const numericName = /^(?:0|[1-9][0-9]*)$/.test(name)
    return [...(keyedStores.named.get(name) ?? []), ...keyedStores.unproven.filter((store) => store.numericOnly !== true || numericName)]
  }
  /** The intrinsic obligations of the keyed stores each field's binding read, published once the census settles. */
  const keyedRequirements = new Map<ts.Symbol, readonly IntrinsicProtocolRequirement[]>()
  const ancestryOf = (declaration: ts.ClassLikeDeclaration): ReadonlySet<ts.ClassLikeDeclaration> => {
    const seen = new Set<ts.ClassLikeDeclaration>([declaration])
    const queue = [checker.getTypeAtLocation(declaration)]
    for (let type = queue.pop(); type; type = queue.pop()) {
      if (!(type.flags & ts.TypeFlags.Object) || !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) continue
      for (const base of checker.getBaseTypes(type as ts.InterfaceType)) {
        const baseDeclaration = base.getSymbol()?.declarations?.find(ts.isClassLike)
        if (baseDeclaration && !seen.has(baseDeclaration)) {
          seen.add(baseDeclaration)
          queue.push(base)
        }
      }
    }
    return seen
  }
  /** The `values` of a `values[ key ]` the stored value is (directly or through a `const` binding), keyed by the store's own key binding. */
  const enumeratedSourceOf = (value: ts.Expression, key: ts.Expression): ts.Expression | null => {
    let read = unwrapParens(value)
    if (ts.isIdentifier(read)) {
      const declaration = checker.getSymbolAtLocation(read)?.valueDeclaration
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
      if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return null
      read = unwrapParens(declaration.initializer)
    }
    if (!ts.isElementAccessExpression(read) || !ts.isIdentifier(key) || !ts.isIdentifier(read.argumentExpression)) return null
    const keySymbol = checker.getSymbolAtLocation(key)
    return keySymbol && checker.getSymbolAtLocation(read.argumentExpression) === keySymbol ? read.expression : null
  }
  /** The classes that declare `symbol`'s storage. */
  const ownersOf = (symbol: ts.Symbol): ReadonlySet<ts.ClassLikeDeclaration> =>
    new Set(
      (symbol.declarations ?? []).map((declaration) => ts.findAncestor(declaration, ts.isClassLike)).filter((owner) => owner !== undefined)
    )
  /** Whether a store into an instance of `owner` can land in storage one of `owners` declares. */
  const reachesOwners = (owners: ReadonlySet<ts.ClassLikeDeclaration>, owner: ts.ClassLikeDeclaration): boolean =>
    [...owners].some((declared) => ancestryOf(declared).has(owner) || ancestryOf(owner).has(declared))
  /** Every keyed store, proven or not, that can land in `symbol`'s storage. */
  const keyedStoresInto = (symbol: ts.Symbol): readonly KeyedStore[] => {
    const owners = ownersOf(symbol)
    return owners.size === 0 ? [] : keyedStoresNamed(symbol.name).filter((store) => reachesOwners(owners, store.owner))
  }
  /** Each proven-key store into `symbol`: the type it writes, or `null` where nothing types it. */
  const keyedWriteTypesOf = (symbol: ts.Symbol): readonly (ts.Type | null)[] => {
    const answers: (ts.Type | null)[] = []
    const requirements: IntrinsicProtocolRequirement[] = []
    for (const store of keyedStoresInto(symbol)) {
      requirements.push(...store.requirements)
      const source = enumeratedSourceOf(store.value, store.key)
      if (source) {
        const holder = knownOrResolve(source)
        answers.push(holder ? propertyTypeOf(holder, symbol.name, store.value) : null)
      } else answers.push(parameters.statedTypeAt(store.value) ?? known(store.value) ?? resolveExpr(store.value))
    }
    if (requirements.length > 0) keyedRequirements.set(symbol, requirements)
    return answers
  }

  /**
   * The checker's own answer at this node, when it says something usable.
   *
   * `annotationStatesNothing` is part of the test, not just
   * `isUnusableEvidence`, and the difference is the single measured root of
   * the vacuous-receiver family: a JSDoc class writes `@type {?Object}` above
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
   * program -- `this.nameIndex[ name ] = m` reached from a
   * different method than the one that creates `nameIndex`,
   * several separate times in unrelated classes
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
  const nodeMemo = new NullableMemo<ts.Node, ts.Type>()
  const nodeResolving = new Set<ts.Node>()

  // The closed-family fallback is the parameter census's own rule, asked the
  // same way -- see `flow/class-family-member-read.ts`.
  const propertyTypeOf = (receiver: ts.Type, name: string, at: ts.Node): ts.Type | null =>
    memberTypeOf(checker, receiver, name, at, flow, parameters) ?? classFamilyMemberReadTypeOf(checker, flow, receiver, name, parameters)
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
   * operation, carries the field natively all the same. A constructor that
   * defines `levels` through `Object.defineProperties` is the case
   * (`define-property-source-transform.ts` lowers
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
   * `slots.lut` on `Slots = Record<string, Slot>` -- or `null` when the
   * receiver declares the member (or nothing at all).
   *
   * Such a read names no property symbol, so `memberSymbolOf` and
   * `propertyTypeOf` both answered nothing and every `slots.X.value = v`
   * store boxed the slot to write through `reflectSet`. Answering the index
   * signature's value type ALONE is the
   * other failure: `slots.lut !== undefined` then folded to `true` and a
   * record that has no `lut` dereferenced the null slot. The read is the
   * value OR absence, which is the same
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
    const keyedTypes = keyedWriteTypesOf(symbol)
    const writes = writesOf(symbol)
    const types: ts.Type[] = keyedTypes.filter((type) => type !== null)
    let silent = keyedTypes.length - types.length
    /** The types of `{}` literals written here: fresh objects with no keys, see `recordWithOptionalMembersOf`. */
    const freshEmpty = new Set<ts.Type>()
    const freshEmptyWrites: ts.Expression[] = []
    let refused: string | null = null
    for (const write of writes) {
      // A STATED CELL THE UPSTREAM CENSUS NARROWED OUTRANKS THE CHECKER at
      // this write. `known` asks the checker first everywhere else, which is
      // right when the checker's answer is the last word about the value --
      // and wrong for exactly the value whose own cell was narrowed WITHIN a
      // statement the checker still reports in full. A constructor's
      // `this.#matchResult = matchResult` is the measured case: the parameter
      // census already bound `matchResult` to the concrete
      // `Result<[H, Route]>` its only caller passes, while the checker
      // keeps answering the annotation's `Result<[unknown, Route]>`, so
      // reading the checker here typed the FIELD as the upper bound and left
      // the store between two disagreeing carriers -- the same
      // two-authorities split every census here exists to close, one hop
      // downstream. `statedTypeAt` answers only where such a narrowing was
      // admitted, so this changes nothing anywhere else.
      // An EMPTY literal the program writes is a fresh object with zero
      // members, not the vacuous `{}` annotation `known` rightly discards --
      // the same holder `parameter-bindings.ts`/`local-bindings.ts` already
      // read it as (`exactEmptyObjectLiteralType`). A JSDoc
      // `/** @type {Object} */ this.extra = {};` is the measured case:
      // with that write silent, every class's `extra` fell back to the
      // annotation's `any` and boxed the empty object it only ever holds.
      const stated = parameters.statedTypeAt(write)
      const empty = stated ? null : exactEmptyObjectLiteralType(checker, write)
      if (empty) {
        freshEmpty.add(empty)
        freshEmptyWrites.push(write)
      }
      const type = stated ?? empty ?? known(write) ?? resolveExpr(write)
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
    if (writes.length === 0 && keyedTypes.length === 0) attribute(symbol, 'no-writes')
    else if (refused) attribute(symbol, refused)
    // EVIDENCE EXHAUSTED -- the same rule, the same order, as
    // `parameter-bindings.ts`'s `skipSilentSites` phase: a write that states
    // nothing is not a write that disagrees. In the strict phase one silent
    // write still refuses the whole field; the relaxed retry (below, run only
    // over fields the strict pass could not bind) joins the writes that DO
    // speak. `writes-disagree` still fires over what remains, and a field
    // whose every write is silent refuses exactly as before. Measured shape:
    // a vector class's `x`/`y`/`z` carry dozens of writes each, all typed
    // `number` but one (`this.x = e[ 12 ]`, `e` unannotated) silent -- every
    // read boxed by a veto that read no fact.
    // Writes that speak only of ABSENCE do not count: `this.shaku = null` in a
    // constructor, filled later by one silent `this.shaku = index.shakuhachi`,
    // joined to `null` alone, and that silent write -- the only one carrying
    // what the field holds -- then aborted in its checked unbox.
    else if (silent > 0 && (!lenientPhase || types.every(isNullish))) attribute(symbol, 'write-unresolved')
    else {
      // A FRESH `{}` written into the field contributes a value with no keys,
      // never a layout: joined with record `R` the field holds either that
      // empty object or an `R`, which is exactly `R` with every member
      // optional. Letting the `{}` take part in the join instead widened the
      // field to the empty record (every `R` is assignable to `{}`), and an
      // `R` stored there survived only as a view of a layout that names none
      // of its keys.
      const keyed = types.filter((type) => !freshEmpty.has(type))
      const joinedKeyed = freshEmpty.size > 0 && keyed.length > 0 ? joinOfWrites(checker, keyed) : null
      const optional = joinedKeyed ? recordWithOptionalMembersOf(checker, joinedKeyed) : null
      // The literal's only home is this field, so it is allocated in the
      // field's own layout -- with every member absent -- rather than as a
      // keyless record the field would then have to view.
      if (optional) for (const write of freshEmptyWrites) freshEmptyHomes.set(write, optional)
      const joined = optional ?? joinOfWrites(checker, types)
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
    if (classSatisfiesInterface && result) state(symbol, result)
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
      } else if (result && !statedFieldAdmits(checker, stated.declaration, stated.bound, result)) {
        result = null
        attribute(symbol, 'stated-field-narrows-a-stated-position')
      }
      if (result) state(symbol, result)
    }
    // An assignment-only JavaScript field the CHECKER types with an unstated
    // leaf -- `this.groups = []` is `any[]` to it, and so is a tag
    // naming a type the file never imports (`@type {Array<Group>}`)
    // -- is the stated-field case with the checker
    // as the statement: a structure whose one open position the writes fill.
    // The layout resolver keeps a checker answer that is not itself `any`, so
    // `typeAt` alone left the cell at `any[]` while the census had joined the
    // writes to `Group[]`; every typed write then asked to convert a
    // shared array into a boxed one, which no copy can do without breaking
    // the alias. Published through `statedTypeAt` only where the join differs
    // from the checker's answer at the unstated positions alone.
    if (!stated && declaredInterface === null && result && !statedBindings.has(symbol)) {
      const anchor = symbol.declarations?.[0]
      const checkerType = anchor ? checker.getTypeOfSymbolAtLocation(symbol, anchor) : null
      if (
        anchor &&
        checkerType &&
        (checkerType.flags & ts.TypeFlags.Any) === 0 &&
        !annotationStatesNothing(checker, anchor, checkerType) &&
        containsUnstatedPosition(checker, anchor, checkerType) &&
        !carriesUnsubstitutedGeneric(checker, result) &&
        narrowsOnlyUnstatedPositions(checker, anchor, checkerType, result)
      )
        state(symbol, result)
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
      // AND the receiver and still boxed the read between them: a factory
      // function `Helper( renderer, ... )` binds `renderer` from its one call
      // site, `renderer.state` resolved to the typed struct field in the
      // emitted C++, and `const _state = renderer.state` was laid out
      // `gea::Value` from the checker's `any` -- every `_state.setBlending()`
      // then went through dynamic lookup and threw on the first frame.
      const member = symbol ? null : memberSymbolOf(receiver, node.name.text)
      if (member && isCandidateSymbol(checker, member)) return resolveSymbol(member)
      const typed = propertyTypeOf(receiver, node.name.text, node)
      if (typed) return typed
      // An OBJECT-LITERAL member the checker types `any` still has the one
      // expression that filled it. A factory function that returns
      // `{ buffers: { depth: depthBuffer, ... } }` is the case, where `depthBuffer` is
      // `new DepthBuffer()` -- `new` on a JS factory with no construct
      // signature, `any` to the checker, a typed record to this census (the
      // parameter census reads the factory's return). The literal's LAYOUT was
      // already derived from that initializer, so the struct carries `depth`
      // natively; a READ answered `null` here instead, and the emitter then
      // boxed the native callable field to call it dynamically -- which threw
      // on the first call. Answer the read from the
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

  /**
   * Storage the program never typed is laid out from what its writes say, and
   * a write of a value nothing types says nothing -- yet it stores whatever
   * the value is. `this.vertexShader = 'default'` in a constructor and
   * `this.vertexShader = source.vertexShader` in a `copy(source)` whose
   * `source` no census can type: the checker answers `string` from the
   * constructor alone (and the relaxed phase above joins only the writes that
   * speak), the copy converts its boxed value through a checked unbox, and the
   * first source without the key aborts where Node stores `undefined`.
   *
   * Such a field can hold any value, so it holds `any`. Published through
   * `statedTypeAt`, which the layout resolver and the member mapper both take
   * ahead of the checker, so the slot, its writes and every read of it agree.
   * A field written only with typed values -- including a copy whose source
   * the parameter census typed -- keeps its narrow carrier. A program that
   * typed the field (an annotation, a JSDoc tag) keeps its statement.
   */
  const statesNothingAbout = (declaration: ts.Declaration): boolean => {
    if (isBareFieldDeclaration(checker, declaration)) return true
    if (!isAssignmentDeclaration(declaration)) return false
    const jsDocType = ts.getJSDocType(declaration)
    return !jsDocType || jsDocTypeStatesNothing(checker, jsDocType)
  }
  const widenedFields = new Set<ts.Symbol>()
  /**
   * The candidate field a member read copies, by declaration: a read through a
   * receiver only the census typed names the instance type's own property
   * symbol, a different object from the one the writes declared, and that one
   * was never resolved -- `this.text = source.text` with `source` bound to
   * the class itself would otherwise read as a value nothing types.
   */
  const copiedFieldOf = (read: ts.PropertyAccessExpression): ts.Symbol | null => {
    const symbol = memberSymbolAt(read)
    if (!symbol) return null
    if (candidateSymbols.has(symbol) || statedFieldSymbols.has(symbol)) return symbol
    const first = symbol.declarations?.[0]
    return first === undefined ? null : (candidateByDeclaration().get(first) ?? null)
  }
  let candidatesByDeclaration: Map<ts.Node, ts.Symbol> | undefined
  const candidateByDeclaration = (): ReadonlyMap<ts.Node, ts.Symbol> => {
    if (candidatesByDeclaration) return candidatesByDeclaration
    candidatesByDeclaration = new Map()
    for (const symbol of [...candidateSymbols, ...statedFieldSymbols])
      for (const declaration of symbol.declarations ?? []) candidatesByDeclaration.set(declaration, symbol)
    return candidatesByDeclaration
  }
  const readsWidenedField = (value: ts.Expression): boolean => {
    const unwrapped = unwrapParens(value)
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const symbol = copiedFieldOf(unwrapped)
      return symbol !== null && widenedFields.has(symbol)
    }
    if (ts.isConditionalExpression(unwrapped)) return readsWidenedField(unwrapped.whenTrue) || readsWidenedField(unwrapped.whenFalse)
    if (ts.isBinaryExpression(unwrapped)) {
      const operator = unwrapped.operatorToken.kind
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return readsWidenedField(unwrapped.left) || readsWidenedField(unwrapped.right)
    }
    return false
  }
  /**
   * Whether `source` -- an object a field's value is read out of under
   * `key` (`null` for a merge or a keyed copy, which reads only the keys the
   * object holds) -- can hand the field a value nothing types.
   *
   * A source the census typed reads that layout, where a member it lacks is
   * an absence, not an unknown value. A parameter no census typed holds what
   * its callers pass: it is such a source only when some call site passes an
   * object nothing types, or a record that lacks `key` or declares it `any`.
   * Every caller passing a typed object -- a vector, a camera, an options
   * literal -- leaves the read typed although the parameter itself is boxed.
   * A class instance is not taken to lack a member a subclass may declare.
   */
  const untypedSource = (source: ts.Expression | ts.ParameterDeclaration, key: string | null, depth = 0): boolean => {
    if (ts.isParameter(source)) return parameterSuppliesUntypedSource(source, key, depth)
    if (readsWidenedField(source)) return true
    if ((checker.getTypeAtLocation(source).flags & ts.TypeFlags.Any) === 0) return false
    if (parameters.statedTypeAt(source) || receiverTypeOf(source)) return false
    const unwrapped = unwrapParens(source)
    // An object the checker types `any` is only as untyped as where it came
    // from: a call's result, a member read, a `const` holding either.
    if (ts.isCallExpression(unwrapped) || ts.isNewExpression(unwrapped)) return callReturnsDynamicValue(unwrapped, depth)
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) return writesDynamicValue(unwrapped, depth + 1)
    if (!ts.isIdentifier(unwrapped)) return true
    const declaration = checker.getSymbolAtLocation(unwrapped)?.valueDeclaration
    if (declaration && ts.isParameter(declaration)) return parameterSuppliesUntypedSource(declaration, key, depth)
    if (declaration && ts.isVariableDeclaration(declaration) && parameters.typeAt(declaration)) return false
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
      depth <= 8
    )
      return untypedSource(declaration.initializer, key, depth + 1)
    return true
  }
  /** The values a parameter receives: its default, its call sites' arguments, and its body's own assignments to it. */
  const valuesReceivedBy = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] => {
    const symbol = ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined
    const received: ts.Expression[] = parameter.initializer ? [parameter.initializer] : []
    for (const write of symbol ? flow.writesToSymbol(symbol) : [])
      if (
        write.value !== null &&
        write.slot === 'whole' &&
        (write.edge === 'call-argument' ||
          write.edge === 'super-argument' ||
          write.edge === 'identifier-assignment' ||
          write.edge === 'logical-assignment')
      )
        received.push(write.value)
    return received
  }
  /** Whether a typed object of `type` can answer `key` with an absence or an `any`. */
  const typedSourceLeavesKeyUntyped = (type: ts.Type, key: string, at: ts.Node): boolean => {
    const holder = checker.getNonNullableType(type)
    const arms = holder.isUnion() ? holder.types : [holder]
    return arms.some((arm) => {
      if ((arm.flags & ts.TypeFlags.Object) === 0) return false
      const member = checker.getPropertyOfType(arm, key)
      if (!member) {
        if (isClassInstanceType(arm)) return false
        const index = checker.getIndexTypeOfType(arm, ts.IndexKind.String)
        return index === undefined || (index.flags & ts.TypeFlags.Any) !== 0
      }
      const declaration = member.valueDeclaration
      if (declaration && ts.isPropertyAssignment(declaration)) return writesDynamicValue(declaration.initializer)
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) return writesDynamicValue(declaration.name)
      if (declaration && ts.isBinaryExpression(declaration)) return false
      return (checker.getTypeOfSymbolAtLocation(member, at).flags & ts.TypeFlags.Any) !== 0
    })
  }
  const visitingSourceParameters = new Set<ts.ParameterDeclaration>()
  const parameterSuppliesUntypedSource = (parameter: ts.ParameterDeclaration, key: string | null, depth: number): boolean => {
    if (parameters.typeAt(parameter)) return false
    // A destructured parameter names no slot the flow index files call-site
    // arguments against, so its callers cannot be asked: its own type is the
    // pattern's implied record of `any` members, and that is what it supplies.
    if (!ts.isIdentifier(parameter.name)) return true
    if (depth > 8 || visitingSourceParameters.has(parameter)) return false
    visitingSourceParameters.add(parameter)
    try {
      return valuesReceivedBy(parameter).some((value) => {
        if (untypedSource(value, key, depth + 1)) return true
        if (key === null) return false
        const type = knownOrResolve(value)
        return type !== null && typedSourceLeavesKeyUntyped(type, key, value)
      })
    } finally {
      visitingSourceParameters.delete(parameter)
    }
  }
  /**
   * A member read off a receiver the census typed, whose own type for the
   * member is `any`: an index signature of `any` (`Record<string, any>`),
   * a member a statement declares `any`, or an object literal's member
   * filled with a dynamic value. The layout knows the receiver and not what
   * the member holds. A member the receiver lacks is an absence, and a
   * literal's member holds what its initializer does.
   */
  const readsDeclaredDynamicMember = (read: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number): boolean => {
    const receiver = receiverTypeOf(read.expression)
    if (!receiver) return false
    const holder = checker.getNonNullableType(receiver)
    const key = ts.isPropertyAccessExpression(read) ? read.name.text : literalMemberNameOf(read)
    const isAny = (type: ts.Type | undefined): boolean => type !== undefined && (type.flags & ts.TypeFlags.Any) !== 0
    if (key === null) {
      const keyType = ts.isElementAccessExpression(read) ? checker.getTypeAtLocation(read.argumentExpression) : undefined
      const numeric = keyType !== undefined && (keyType.flags & ts.TypeFlags.NumberLike) !== 0
      return isAny(checker.getIndexTypeOfType(holder, numeric ? ts.IndexKind.Number : ts.IndexKind.String) ?? undefined)
    }
    const member = checker.getPropertyOfType(holder, key)
    if (!member) return isAny(checker.getIndexTypeOfType(holder, ts.IndexKind.String) ?? undefined)
    const declaration = member.valueDeclaration
    if (declaration && ts.isPropertyAssignment(declaration)) return writesDynamicValue(declaration.initializer, depth + 1)
    if (declaration && ts.isShorthandPropertyAssignment(declaration)) return writesDynamicValue(declaration.name, depth + 1)
    if (declaration && ts.isBinaryExpression(declaration)) return false
    return isAny(checker.getTypeOfSymbolAtLocation(member, read))
  }
  /** The object a binding element destructures, when the pattern is one level deep. */
  const destructuredSourceOf = (element: ts.BindingElement): ts.Expression | ts.ParameterDeclaration | null => {
    if (element.dotDotDotToken || !ts.isObjectBindingPattern(element.parent)) return null
    const holder = element.parent.parent
    if (ts.isParameter(holder)) return holder
    return ts.isVariableDeclaration(holder) && holder.initializer ? holder.initializer : null
  }
  /** Whether `value` reaches its field as an untyped dynamic value, whatever it holds. */
  const writesDynamicValue = (value: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false
    if (readsWidenedField(value)) return true
    if ((checker.getTypeAtLocation(value).flags & ts.TypeFlags.Any) === 0) return false
    const unwrapped = unwrapParens(value)
    // A copy out of another candidate field holds what that field holds:
    // dynamic exactly when that field is widened, which the fixpoint decides.
    if (ts.isPropertyAccessExpression(unwrapped) && copiedFieldOf(unwrapped)) return false
    if (parameters.statedTypeAt(value) || exactEmptyObjectLiteralType(checker, value)) return false
    // The checker's `any` for a conditional or a logical fallback is only as
    // dynamic as its operands: `opts ? opts.deduplicate : null` or
    // `opts.pageOffset || 0` over an `opts` the census typed stores that
    // record's member, an absence, or the literal.
    if (ts.isConditionalExpression(unwrapped))
      return writesDynamicValue(unwrapped.whenTrue, depth + 1) || writesDynamicValue(unwrapped.whenFalse, depth + 1)
    if (ts.isBinaryExpression(unwrapped)) {
      const operator = unwrapped.operatorToken.kind
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return writesDynamicValue(unwrapped.left, depth + 1) || writesDynamicValue(unwrapped.right, depth + 1)
    }
    // A member read out of an untyped object hands the field whatever the
    // object holds: `source.label`, `values[ key ]`, a binding destructured
    // from one, or a `const` holding one. Off a typed receiver it is dynamic
    // only where the receiver declares the member `any`.
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      if (resolveExpr(value) !== null) return false
      const key = ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name.text : literalMemberNameOf(unwrapped)
      return untypedSource(unwrapped.expression, key, depth) || readsDeclaredDynamicMember(unwrapped, depth)
    }
    if (ts.isCallExpression(unwrapped) || ts.isNewExpression(unwrapped)) return callReturnsDynamicValue(unwrapped, depth)
    if (!ts.isIdentifier(unwrapped)) return false
    const declaration = checker.getSymbolAtLocation(unwrapped)?.valueDeclaration
    if (declaration && ts.isParameter(declaration)) return parameterReceivesDynamicValue(declaration, depth)
    if (declaration && ts.isBindingElement(declaration)) {
      const source = destructuredSourceOf(declaration)
      const name = declaration.propertyName ?? declaration.name
      const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null
      return source !== null && untypedSource(source, key, depth)
    }
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isIdentifier(declaration.name))
      return false
    if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return false
    return writesDynamicValue(declaration.initializer, depth + 1)
  }
  /**
   * A parameter no census typed holds what its callers pass, and what its own
   * body assigns it: dynamic only where one of those is. Every caller passing
   * a typed value -- a vector's `set( x, y, z )` called with numbers and with
   * a typed record's members -- leaves the field it fills native, although
   * the parameter itself is boxed. A parameter that reaches itself (a
   * recursive call forwarding it) adds nothing.
   */
  const visitingParameters = new Set<ts.ParameterDeclaration>()
  const parameterReceivesDynamicValue = (parameter: ts.ParameterDeclaration, depth: number): boolean => {
    if (parameters.typeAt(parameter) || visitingParameters.has(parameter) || !ts.isIdentifier(parameter.name)) return false
    const symbol = checker.getSymbolAtLocation(parameter.name)
    if (!symbol) return false
    visitingParameters.add(parameter)
    try {
      const dynamic = valuesReceivedBy(parameter).find((value) => writesDynamicValue(value, depth + 1))
      if (dynamic && WIDEN_DEBUG) {
        const file = dynamic.getSourceFile()
        const line = file.getLineAndCharacterOfPosition(dynamic.getStart()).line + 1
        process.stderr.write(
          `[WIDEN-ARG] ${parameter.name.getText()} <- ${file.fileName}:${line} ${dynamic.getText().replace(/\s+/g, ' ').slice(0, 100)}\n`
        )
      }
      return dynamic !== undefined
    } finally {
      visitingParameters.delete(parameter)
    }
  }
  /**
   * A call the checker types `any` and no census resolved: a host function
   * declared to return `any` (`JSON.parse`) or a callee nothing names
   * returns whatever it produces; a function of the program returns what its
   * `return` statements do.
   */
  const visitingCallees = new Set<ts.Node>()
  const isGlobalObjectCreate = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const target = call.expression
    return (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(target) &&
      target.name.text === 'create' &&
      isGlobalObjectConstructor(checker, target.expression, checker.getTypeAtLocation(target.expression))
    )
  }
  /**
   * `attribute.getX( index )` where `attribute` is a parameter no census
   * typed: the checker names no callee, but each call site passes an object
   * the census types, and the method that object declares returns what its
   * own `return` statements do. A receiver nothing types at some call site
   * makes the result dynamic; any other receiver is asked through the
   * census's own type for it, and one the census cannot type is no evidence.
   * A call that is not a method call returns whatever it produces.
   */
  const methodOfUntypedReceiverReturnsDynamicValue = (call: ts.CallExpression | ts.NewExpression, depth: number): boolean => {
    const target = unwrapParens(call.expression)
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(target)) return true
    const receiver = unwrapParens(target.expression)
    const declaration = ts.isIdentifier(receiver) ? checker.getSymbolAtLocation(receiver)?.valueDeclaration : undefined
    const isUntypedParameter = declaration !== undefined && ts.isParameter(declaration) && !parameters.typeAt(declaration)
    if (depth > 8) return false
    if (!isUntypedParameter) {
      // Any other receiver: the census's own type for it, when it has one.
      if (untypedSource(receiver, null, depth + 1)) return true
      const type = knownOrResolve(receiver)
      return type !== null && methodOfTypeReturnsDynamicValue(type, target.name.text, call, depth)
    }
    const parameter = declaration as ts.ParameterDeclaration
    if (visitingSourceParameters.has(parameter)) return false
    visitingSourceParameters.add(parameter)
    try {
      return valuesReceivedBy(parameter).some((value) => {
        if (untypedSource(value, null, depth + 1)) return true
        const type = knownOrResolve(value)
        return type !== null && methodOfTypeReturnsDynamicValue(type, target.name.text, call, depth)
      })
    } finally {
      visitingSourceParameters.delete(parameter)
    }
  }
  /** Whether calling `name` on an object of `type` can return a value nothing types. */
  const methodOfTypeReturnsDynamicValue = (type: ts.Type, name: string, call: ts.CallExpression, depth: number): boolean => {
    const holder = checker.getNonNullableType(type)
    return (holder.isUnion() ? holder.types : [holder]).some((arm) => {
      const method = checker.getPropertyOfType(arm, name)
      const body = method?.valueDeclaration
      if (!method || !body) return false
      if (body.getSourceFile().isDeclarationFile) {
        const signatures = checker.getTypeOfSymbolAtLocation(method, call).getCallSignatures()
        return signatures.some((signature) => (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Any) !== 0)
      }
      return ts.isFunctionLike(body) && functionReturnsDynamicValue(body, depth)
    })
  }
  /** Whether one of a program function's own `return` statements hands back a value nothing types. */
  const functionReturnsDynamicValue = (callee: ts.SignatureDeclaration, depth: number): boolean => {
    if (!('body' in callee) || !callee.body) return true
    if (visitingCallees.has(callee)) return false
    visitingCallees.add(callee)
    try {
      const body = callee.body
      if (!ts.isBlock(body)) return writesDynamicValue(body as ts.Expression, depth + 1)
      let dynamic = false
      const visit = (node: ts.Node): void => {
        if (dynamic || (node !== body && ts.isFunctionLike(node))) return
        if (ts.isReturnStatement(node) && node.expression && writesDynamicValue(node.expression, depth + 1)) dynamic = true
        else ts.forEachChild(node, visit)
      }
      visit(body)
      return dynamic
    } finally {
      visitingCallees.delete(callee)
    }
  }
  /**
   * `entries.get( key )` on a Map or Set the program built without type
   * arguments: the checker answers `any`, but the collection holds what the
   * program's own `set`/`add` calls put in it -- dynamic only where one of
   * those values is.
   */
  const collectionReadIsTyped = (call: ts.CallExpression | ts.NewExpression, depth: number): boolean => {
    const target = unwrapParens(call.expression)
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(target) || target.name.text !== 'get') return false
    const receiver = unwrapParens(target.expression)
    const symbol = ts.isIdentifier(receiver)
      ? checker.getSymbolAtLocation(receiver)
      : ts.isPropertyAccessExpression(receiver)
        ? memberSymbolAt(receiver)
        : null
    if (!symbol) return false
    const values = flow.writesToSymbol(symbol).filter((write) => write.edge === 'collection-value' && write.value !== null)
    return values.length > 0 && !values.some((write) => writesDynamicValue(write.value!, depth + 1))
  }
  const callReturnsDynamicValue = (call: ts.CallExpression | ts.NewExpression, depth: number): boolean => {
    if (resolveExpr(call) !== null) return false
    const callee = checker.getResolvedSignature(call)?.getDeclaration()
    if (!callee) return methodOfUntypedReceiverReturnsDynamicValue(call, depth)
    // `Object.create( proto )` is declared to return `any`, but it builds a
    // fresh object holding none of the program's values; storing it is the
    // ordinary conversion of an empty object into the field's carrier.
    if (callee.getSourceFile().isDeclarationFile) return !isGlobalObjectCreate(call) && !collectionReadIsTyped(call, depth)
    return !ts.isFunctionLike(callee) || functionReturnsDynamicValue(callee, depth)
  }
  const dynamicWriteEvidence = (write: ValueWrite): boolean =>
    write.slot === 'whole' &&
    write.value !== null &&
    (write.edge === 'property-assignment' ||
      write.edge === 'class-field-initializer' ||
      write.edge === 'index-assignment' ||
      write.edge === 'logical-assignment' ||
      write.edge === 'destructuring-default')
  /**
   * The object a destructuring ASSIGNMENT target is filled from, when the
   * pattern is the left side of the `=` itself: `({ label: this.label } = source)`.
   */
  const assignedPatternSourceOf = (target: ts.Expression): ts.Expression | null => {
    let node: ts.Node = target
    // `this.label = fallback` inside the pattern is the target with a default.
    if (ts.isBinaryExpression(node.parent) && node.parent.left === node) node = node.parent
    const property = node.parent
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null
    const pattern = property.parent
    const assignment = pattern.parent
    if (!ts.isObjectLiteralExpression(pattern) || !ts.isBinaryExpression(assignment)) return null
    return assignment.left === pattern && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken ? assignment.right : null
  }
  /**
   * `Object.assign(target, source)` with an untyped `source` copies whatever
   * keys it holds onto `target`: a write of an unknown value into every field
   * of each class `target` may be an instance of.
   */
  let untypedMerges: readonly { readonly owners: readonly ts.ClassLikeDeclaration[]; readonly site: ts.Node }[] | undefined
  const untypedMergeInto = (symbol: ts.Symbol): ts.Node | null => {
    untypedMerges ??= flow.allWrites.flatMap((write) => {
      if (write.edge !== 'object-assign' || !write.naming || !write.value || !untypedSource(write.value, null)) return []
      const owners = instanceClassesOf(write.naming)
      return owners.length > 0 ? [{ owners, site: write.site }] : []
    })
    if (untypedMerges.length === 0) return null
    const owners = ownersOf(symbol)
    return untypedMerges.find((merge) => merge.owners.some((owner) => reachesOwners(owners, owner)))?.site ?? null
  }
  /** The first write that stores a value nothing types into `symbol`'s storage, or `null`. */
  const dynamicWriteInto = (symbol: ts.Symbol): ts.Node | null => {
    // A JavaScript field's declarations are its writes, listed whether or not
    // the program runs them; the flow index already leaves pruned code out.
    for (const declaration of symbol.declarations ?? [])
      if (ts.isBinaryExpression(declaration) && nodeIsReachable(reachable, declaration) && writesDynamicValue(declaration.right))
        return declaration
    for (const write of flow.writesToSymbol(symbol)) {
      if (dynamicWriteEvidence(write) && writesDynamicValue(write.value!)) return write.site
      if (write.edge !== 'destructuring' || write.slot !== 'whole' || !write.naming) continue
      const source = assignedPatternSourceOf(write.naming)
      const property = write.naming.parent
      const name =
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isBinaryExpression(property) &&
              (ts.isPropertyAssignment(property.parent) || ts.isShorthandPropertyAssignment(property.parent))
            ? property.parent.name
            : undefined
      const key = name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? name.text : null
      if (source && untypedSource(source, key)) return write.site
    }
    for (const store of keyedStoresInto(symbol)) {
      const source = enumeratedSourceOf(store.value, store.key)
      if (source ? untypedSource(source, null) : writesDynamicValue(store.value)) return store.value
    }
    return untypedMergeInto(symbol)
  }
  const widenDynamicallyWrittenFields = (): void => {
    // A field the program typed is held to that statement everywhere the
    // checker relates a value to it -- and an `any` value is related to
    // nothing: `this.label = document.label` off an `any`-valued record
    // stores whatever the document held. Such a field is widened exactly as
    // an untyped one is, from the same evidence; a typed field every write of
    // which is typed keeps its native carrier.
    const unstated = [
      ...[...candidateSymbols].filter((symbol) => (symbol.declarations ?? []).every(statesNothingAbout)),
      ...statedFieldSymbols
    ]
    if (unstated.length === 0) return
    // Asked again of the settled census: a write read during the strict phase
    // may have been silent only because the field it reads was still being
    // resolved -- `this.text = source.text` copying another instance's own.
    nodeMemo.clear()
    for (let changed = true; changed;) {
      changed = false
      for (const symbol of unstated) {
        if (widenedFields.has(symbol)) continue
        const evidence = dynamicWriteInto(symbol)
        if (!evidence) continue
        widenedFields.add(symbol)
        changed = true
        // `GEA_WIDEN_DEBUG=1` names each widened field and the write that
        // widened it -- the one fact a moved carrier needs to be judged by.
        if (WIDEN_DEBUG) {
          const file = evidence.getSourceFile()
          const line = file.getLineAndCharacterOfPosition(evidence.getStart()).line + 1
          const owner = ownersOf(symbol).values().next().value?.name?.text ?? '?'
          const kind = statedFieldSymbols.has(symbol) ? 'stated' : 'inferred'
          process.stderr.write(
            `[WIDEN] ${owner}.${symbol.name} ${kind} <- ${file.fileName}:${line} ${evidence.getText().replace(/\s+/g, ' ').slice(0, 120)}\n`
          )
        }
      }
    }
    if (widenedFields.size === 0) return
    const dynamic = checker.getAnyType()
    for (const symbol of widenedFields) {
      // A field the checker already types `any` (or `Object`) and this census
      // never narrowed is laid out dynamic as it is: stating it again would
      // change nothing about its storage and would retype every read of it,
      // re-laying out typed cells the program fills from those reads.
      const anchor = symbol.declarations?.[0]
      const checkerAnswer = anchor ? checker.getTypeOfSymbolAtLocation(symbol, anchor) : null
      const alreadyDynamic =
        !bound.has(symbol) &&
        !unionArms.has(symbol) &&
        !statedBindings.has(symbol) &&
        checkerAnswer !== null &&
        anchor !== undefined &&
        (isUnusableEvidence(checkerAnswer) || annotationStatesNothing(checker, anchor, checkerAnswer))
      bound.delete(symbol)
      unionArms.delete(symbol)
      refusalOf.set(symbol, 'write-dynamic')
      if (!alreadyDynamic) state(symbol, dynamic)
    }
    nodeMemo.clear()
  }

  // Enumerate every candidate SYMBOL up front, from every `x.field = expr`
  // write's left-hand side, so `boundCount`/`refusals` reflect the whole
  // program rather than only the nodes some other pass happened to query.
  const candidateSymbols = new Set<ts.Symbol>()
  /** Class fields the program typed -- an annotation or a JSDoc tag -- that some write in the program assigns. */
  const statedFieldSymbols = new Set<ts.Symbol>()
  const statesFieldType = (declaration: ts.Declaration): boolean => {
    if (declaration.getSourceFile().isDeclarationFile || isAmbientDeclaration(declaration)) return false
    if (ts.isPropertyDeclaration(declaration)) {
      if (!ts.isClassLike(declaration.parent)) return false
      if (declaration.type) return true
      const jsDocType = ts.getJSDocType(declaration)
      return jsDocType !== undefined && !jsDocTypeStatesNothing(checker, jsDocType)
    }
    if (!isAssignmentDeclaration(declaration)) return false
    const jsDocType = ts.getJSDocType(declaration)
    return jsDocType !== undefined && !jsDocTypeStatesNothing(checker, jsDocType)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left)
      if (symbol && isCandidateSymbol(checker, symbol)) candidateSymbols.add(symbol)
      const declarations = symbol?.declarations ?? []
      if (symbol && declarations.length > 0 && declarations.every(statesFieldType)) statedFieldSymbols.add(symbol)
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
  widenDynamicallyWrittenFields()
  deferredIntrinsicProtocolLedgerOf(flow)?.replace(
    'field-bindings-keyed-stores',
    [...keyedRequirements].flatMap(([symbol, requirements]) => (bound.has(symbol) ? requirements : []))
  )

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

  /**
   * The field a JavaScript assignment DECLARATION (`this.x = []`) declares,
   * when `node` is one of that symbol's own declarations. The structural
   * mapper asks a member's storage at its declaration node, and for an
   * assignment-only field that node is the whole `BinaryExpression`.
   */
  const assignmentDeclarationSymbolOf = (node: ts.Node): ts.Symbol | undefined => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined
    if (!ts.isPropertyAccessExpression(node.left)) return undefined
    const symbol = memberSymbolAt(node.left)
    return symbol?.declarations?.includes(node) ? symbol : undefined
  }

  /** The `unionArmsAt` shape asked of `statedBindings` -- the same two symbol-resolving node kinds, a leaf lookup rather than a walk. */
  const statedTypeAt = (node: ts.Node): ts.Type | null => {
    if (statedBindings.size === 0) return null
    const symbol =
      ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)
        ? checker.getSymbolAtLocation(node.name)
        : ts.isPropertyAccessExpression(node)
          ? memberSymbolAt(node)
          : ts.isElementAccessExpression(node)
            ? checker.getSymbolAtLocation(node)
            : assignmentDeclarationSymbolOf(node)
    if (!symbol) return null
    const own = statedBindings.get(symbol)
    if (own) return own
    const declarations = symbol.declarations ?? []
    const first = declarations[0]
    const shared = first === undefined ? undefined : statedByDeclaration.get(first)
    // Only a symbol whose EVERY declaration is the bound one's: a subclass that
    // also writes the member names a different storage contract.
    return shared !== undefined && declarations.every((declaration) => statedByDeclaration.get(declaration) === shared) ? shared : null
  }

  return {
    typeAt: (node) => freshEmptyHomes.get(node) ?? resolveExpr(node),
    unionArmsAt,
    statedTypeAt,
    boundCount: bound.size + unionArms.size,
    widenedCount: widenedFields.size,
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
  const skipOuterParentheses = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? skipOuterParentheses(node.expression) : node
  const own = (node: ts.Node): ts.Type | null => parameters.statedTypeAt(node) ?? fields.statedTypeAt(node)
  /**
   * The narrowed RESULT of a call, where the callee is a member this census
   * narrowed to its writer's function (`statedCallableResultBoundOfSignature`):
   * the resolved signature is the member's STATED one, whose declaration is a
   * function-type node no return census can answer, so the result is asked of
   * the writer's own declaration instead.
   */
  const memberCallResultAt = (call: ts.CallExpression): ts.Type | null => {
    const callee = skipOuterParentheses(call.expression)
    if (!ts.isPropertyAccessExpression(callee)) return null
    const member = fields.statedTypeAt(callee)
    const signatures = member?.getCallSignatures() ?? []
    const writer = signatures.length === 1 ? signatures[0]?.getDeclaration() : undefined
    return writer ? parameters.statedTypeAt(writer) : null
  }
  const callResultAt = (node: ts.Expression): ts.Type | null => {
    const call = skipOuterParentheses(node)
    if (!ts.isCallExpression(call)) return null
    return own(call) ?? memberCallResultAt(call)
  }
  /**
   * An unannotated `const` holds exactly what its initializer call returned.
   * Where the return census narrowed that result within its statement, the
   * checker still types the cell -- and every read of it -- as the
   * statement, so the cell asked for a conversion of the returned carrier
   * into the protocol record the annotation names (a
   * `const res = api.parse(...)` holding an `Element[]`
   * as an `Iterable` record, refused at the binding, then again at the
   * `[...res]` that spreads it). A `const` is never rebound, so the
   * initializer's carrier is the cell's for its whole lifetime, and a
   * checker narrowing at a read (`Array.isArray(res) ? res : [...res]`)
   * cannot name a carrier the cell does not hold.
   */
  const heldCallResultAt = (node: ts.Node): ts.Type | null => {
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : ts.isIdentifier(node) && !ts.isVariableDeclaration(node.parent)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.type || !declaration.initializer) return null
    if (!ts.isIdentifier(declaration.name)) return null
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null
    return callResultAt(declaration.initializer)
  }
  const held = new NullableMemo<ts.Node, ts.Type>()
  /**
   * A value read out of a field `widenDynamicallyWrittenFields` widened is
   * whatever the field holds, and so is a cell initialized from one and
   * anything read off it: the checker types all of these from the field's
   * narrow inference, and a slot laid out from that answer would convert the
   * boxed value through the checked unbox the widening removed from the field.
   * Asked only once the census widened something.
   */
  const dynamic = fields.widenedCount > 0 ? checker.getAnyType() : null
  const unstatedCellOf = (node: ts.Node): ts.VariableDeclaration | null => {
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : ts.isIdentifier(node) && !ts.isVariableDeclaration(node.parent)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.type || !declaration.initializer) return null
    if (!ts.isIdentifier(declaration.name) || ts.getJSDocType(declaration)) return null
    // A JSDoc tag on the statement types its declaration too: the program
    // stated what the cell holds.
    const statement = declaration.parent.parent
    if (ts.isVariableStatement(statement) && ts.getJSDocTags(statement).some(ts.isJSDocTypeTag)) return null
    return declaration
  }
  const checkerAnswersAny = (node: ts.Node): boolean => {
    const declared = ts.isVariableDeclaration(node) ? checker.getSymbolAtLocation(node.name) : undefined
    const type = declared ? checker.getTypeOfSymbolAtLocation(declared, node) : checker.getTypeAtLocation(node)
    return (type.flags & ts.TypeFlags.Any) !== 0
  }
  const dynamicThrough = (node: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return readsStatedDynamicValue(statedTypeAt, node.expression)
    if (ts.isCallExpression(node))
      return (
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
        readsStatedDynamicValue(statedTypeAt, node.expression.expression)
      )
    if (ts.isBinaryExpression(node))
      return (
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (readsStatedDynamicValue(statedTypeAt, node.left) || readsStatedDynamicValue(statedTypeAt, node.right))
      )
    const cell = unstatedCellOf(node)
    return cell !== null && readsStatedDynamicValue(statedTypeAt, cell.initializer!)
  }
  const statedTypeAt = (node: ts.Node): ts.Type | null => {
    const answer = own(node)
    if (answer) return answer
    const reads = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    const sum = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    if (!reads && !sum && !ts.isCallExpression(node) && !ts.isVariableDeclaration(node) && !ts.isIdentifier(node)) return null
    if (held.has(node)) return held.get(node) ?? null
    // Placed first so a cell whose initializer reaches back to it answers
    // nothing rather than looping.
    held.set(node, null)
    const result =
      // Only where the checker types the node: an `any` it already answers is
      // dynamic as it stands, and restating it would outrank a census that
      // narrowed it.
      dynamic && !checkerAnswersAny(node) && dynamicThrough(node)
        ? dynamic
        : ts.isCallExpression(node)
          ? memberCallResultAt(node)
          : reads
            ? null
            : heldCallResultAt(node)
    held.set(node, result)
    return result
  }
  return {
    ...parameters,
    typeAt: (node) => parameters.typeAt(node) ?? fields.typeAt(node),
    statedTypeAt,
    unionArmsAt: (node) => parameters.unionArmsAt(node) ?? fields.unionArmsAt(node),
    boundCount: parameters.boundCount + fields.boundCount,
    refusals
  }
}
