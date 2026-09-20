import ts from 'typescript'
import {
  prepareStructuralRules,
  structuralDisagreementsEnabled,
  type StructuralDisagreement,
  type StructuralFormViolation,
  type StructuralRule
} from './structural-rules.js'
import type { ValueFlowIndex } from './flow/model.js'
import { recordStorageFamilies } from './record-storage-families.js'
import { emptyDeclaredMemberCensus, type DeclaredMemberCensus } from './structural-declarations.js'
import { createLocalUnionResolver } from './structural-local-union.js'
import { createMutableMethodResolver } from './structural-mutable-method.js'
import { structuralArrayReadAt } from './structural-array-read.js'
import { enclosingArgumentsFunction, implicitArgumentsSlotOf, isArgumentsObjectIdentifier } from './implicit-arguments.js'
import { createStructuralCallResultResolver, createStructuralConstructResultResolver } from './structural-callable.js'
import type { DeclarationId, StructuralTypeId } from '../../identity/ids.js'
import { genericFunctionChoiceMembersOf, genericSourceFunctionDeclarationOf } from './generic-function-choice.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { StructuralMember, StructuralShape } from '../model/structural-types.js'
import {
  accessorSignatureOf,
  constructorImplementationSignatureOf,
  implementationSignatureOf,
  modifierOnlyMappedSourceOf,
  optionalMethodSignatureOf,
  declaredValueTypeOf,
  physicalInitializerTypeOf,
  physicalOverloadTypeAt,
  physicalStringObjectTypeAt
} from './structural-declarations.js'
import { createKeyofResolver, type KeyofOutcome } from './keyof.js'
import { constructorInstalledMemberDeclarationsOf } from './flow/source-class-data.js'
import {
  arityAdmittedSignature,
  arrayPredicateNarrowedElementTypeOf,
  impliedPatternTargetOf,
  isGlobalObjectInterface,
  isStandardInterfaceType,
  isUnusableEvidence,
  widestOf
} from './derived-expression-type.js'
import { createLeafKeying, literalFor, primitiveFor, symbolKeyDeclarationOf } from './structural-leaves.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { createStructuralParts, selfReferentialCallableShapeOf } from './structural-parts.js'
import { bodyReadsThis, createReceiverResolver } from './structural-receiver.js'
import type { IdentityTable } from './identities.js'
import { createMemberRules, type MemberMode } from './structural-members.js'
import { emptyAbsentGlobalCensus, type AbsentGlobalCensus } from './absent-globals.js'
import { createLayoutTypeResolver } from './structural-layout-type.js'
import { emptyParameterBindingCensus, type ParameterBindingCensus } from './parameter-bindings.js'
import { emptyCollectionBindingCensus, type CollectionBindingCensus } from './collection-bindings.js'
import { bagShapeOfType, bagShapeTypeAt, emptyObjectBagCensus, type ObjectBagCensus } from './object-bag-bindings.js'
import { indexedAccessMemberTypes } from './structural-indexed-access.js'
import { joinedCallableOf, joinedIndexUnionOf } from './structural-joins.js'
import { creationOrderedProperties } from './structural-creation-order.js'
import {
  collectionMemberResultTypeAt,
  contextualArrayConstructTypeAt,
  inferredArrayElementAt,
  statedCollectionTypeAt,
  inferredCollectionTypeArgumentsAt,
  unstatedNeverArray
} from './structural-array-element.js'
import { createDeclaredBodyResolver } from './structural-declared-body.js'
import type { InstantiationCensus } from './instantiation.js'
import { emptyInstantiationCensus } from './instantiation.js'
import { emptySpecializationCensus, type SpecializationCensus } from './specialization.js'
import { createTypeParameterSubstitution } from './structural-generics.js'
import { layoutRelevantParameterIndices } from './structural-layout-relevance.js'
import { rootSpecialization, type SpecializationPath } from './identities.js'
import { emptyInterfaceFamilyCensus, type InterfaceFamily, type InterfaceFamilyCensus } from '../interface-families.js'
import { createInstantiatedMembers, type InstantiatedMembers } from './structural-instantiated-member.js'
import {
  createAliasRecurrence,
  isSelfReferentialSignal,
  createViewIndependentRecurrence,
  selfReferentialKeyOf,
  selfReferentialShapeOf,
  selfReferentialSignal,
  type AliasRecurrence
} from './structural-self-reference.js'
import {
  restParameterArrayElementAt,
  restParameterUnionOfTuplesElementAt,
  censusRestElementAt,
  impliedPatternArrayElementAt
} from './parameter-slot.js'
import { physicalGeneratorOverloadResultAt } from './physical-overload-result.js'
import { arrayAssignmentPatternSourceExpression, arrayAssignmentTargetOf } from './assignment-patterns.js'
import { emptyCommonJsModuleRecordCensus, type CommonJsModuleRecordCensus } from './commonjs-module-record.js'

/**
 * Mapping checker types onto canonical structural shapes.
 *
 * The checker's own type objects are not usable as identity: they are per-
 * program, they carry target-irrelevant flags, and `typeToString` prints two
 * unrelated anonymous objects identically. So every type is translated once
 * into a shape whose canonical key decides identity.
 *
 * When a type cannot be named without inventing authority -- a declarationless
 * object whose members cannot be enumerated, a checker construct this layer does
 * not model -- the answer is `unresolved` with a reason. That is a real answer
 * that fails closed downstream, not a gap to paper over with `any`.
 */

/**
 * One copy of a generic class as the deriver sees it: its ordinal, its
 * layout-relevant fillings folded to structural ids, and the constructor
 * anchor typed inside it (the `class-constructor` shape whose `construct`
 * is the copy's own convention).
 */
export interface ClassCopyKey {
  readonly ordinal: number
  readonly typeArguments: readonly StructuralTypeId[]
  readonly constructor: StructuralTypeId
}

export interface StructuralMapper {
  /**
   * The same mapper, resolving type parameters as the named monomorphized copy
   * binds them.
   *
   * A view rather than a parameter on every method: `typeOf` recurses through a
   * dozen shape builders and threading a path through all of them would put the
   * same forwarded argument in every signature. Each view keeps its own
   * recursion anchors, because `T` really is a different shape in each copy and
   * one memo shared between them would hand the second copy the first one's
   * answer. They share the intern table, which is correct -- a shape is a shape
   * whichever copy produced it.
   */
  /**
   * `bindingPath` separates the two questions one path usually answers
   * together: which copy STAMPS the identities this view mints, and which
   * copies BIND the type parameters it substitutes.
   *
   * They are the same path everywhere but one: a call's RESOLVED signature is
   * a hybrid, whose shape belongs to the callee's declaration and whose type
   * arguments the checker substituted from the CALLER's frame. Scoping it
   * wholly to the callee keeps nested declared types out of the caller's
   * copy -- which is why `producers/shared.ts` scopes it at all -- but leaves
   * a caller type parameter the checker substituted in with nothing to bind
   * it, so `outer<T>(op: T) { inner(op) }` published a callee carrier over a
   * naked `T`. Scoping it wholly to the caller binds that parameter and mints
   * a second copy of every declared type inside the callee's own signature.
   * Neither path answers both; this takes each from the one that owns it.
   */
  readonly forSpecialization: (path: SpecializationPath, bindingPath?: SpecializationPath) => StructuralMapper
  /**
   * What THIS copy binds a type parameter to, returned unchanged when it binds
   * nothing (or the candidate is not a parameter at all).
   *
   * Exposed because "did this copy replace this parameter" is a question a
   * producer has to ask before it can tell a constraint-resolved answer from a
   * substituted one -- `producers/shared.ts`'s `boundReceiverTypeParameter`,
   * where the checker resolves a member on `T`'s CONSTRAINT and the copy knows
   * the concrete receiver that overrides it.
   */
  readonly substituteTypeParameter: (candidate: ts.Type) => ts.Type
  readonly typeOf: (type: ts.Type) => StructuralTypeId
  readonly typeAt: (node: ts.Node) => StructuralTypeId
  readonly mutableMethodStorageTypeAt: (node: ts.MethodDeclaration) => StructuralTypeId | null
  readonly mutableMethodReadTypeAt: (node: ts.Node) => StructuralTypeId | null
  /**
   * What a `Function.prototype.bind` call produces -- the bound callable,
   * receiver-less -- or `null` for any other node. One answer for the two
   * places that state a call's result: `typeAt` on the call and the
   * invocation producer's selected return type (`producers/invocations.ts`),
   * which the producer fails closed on when they disagree.
   */
  readonly boundCallResultAt: (node: ts.Node) => StructuralTypeId | null
  /** The result of every native constructor alternative, shared with the invocation's selected return. */
  readonly constructResultAt: (node: ts.Node) => StructuralTypeId | null
  /** The carrier of the value a declaration binds, which for a class is its constructor object rather than its instances. */
  readonly valueTypeAt: (node: ts.Declaration) => StructuralTypeId
  /**
   * The INSTANCE side of a class node. A class declaration's node type already
   * is its instance type, but a class EXPRESSION is an expression, and the
   * checker types it as its value -- the constructor -- so `typeAt` on
   * `let C = class { y = 4 }` names the constructor object where an instance
   * receiver was meant. Answered from the constructor type's own construct
   * signature, which is the same instance type the class's methods receive
   * (`structural-receiver.ts`'s anonymous-expression branch).
   */
  readonly instanceTypeAt: (node: ts.ClassLikeDeclaration) => StructuralTypeId
  /**
   * The signature of a member read off an evolving array, over the element
   * the census proved rather than the `any`/`never` the checker still holds
   * at the read -- see `evolvingArrayMemberTypeAt` in this file. Exposed so
   * the invocation producer's `resolvedCalleeSignatureType` can prefer it
   * over the checker's resolved signature, which is instantiated from the
   * same stale receiver type and would otherwise re-box every argument.
   */
  readonly evolvingArrayMemberTypeAt: (node: ts.Node) => StructuralTypeId | null
  /**
   * `Object.getOwnPropertyDescriptor(receiver, key)`'s result, minted from the
   * receiver's own structural shape -- see this file's own
   * `objectDescriptorReturnTypeAt` for why `typeAt` already answers a bare
   * CallExpression this way, and why this is exposed the same way
   * `evolvingArrayMemberTypeAt` is: `producers/shared.ts`'s own
   * `objectDescriptorReturnTypeAt` (the invocation producer's own result
   * override, so `mintResult` and `context.types.typeAt` publish the
   * identical answer `validateInvocationResult` requires) delegates here
   * rather than re-deriving the same decision a second way.
   */
  readonly objectDescriptorReturnTypeAt: (node: ts.Node) => StructuralTypeId | null
  /**
   * The shape of one call's own resolved signature -- the convention that
   * specific call actually invokes, with every one of the callee's own type
   * parameters already substituted by the checker's own argument inference.
   *
   * This exists because a generic method's *property* type and the *call*
   * made through it are two different questions: `arr.map`'s property type
   * carries `map`'s own unbound `<U>`, since nothing at that position has
   * committed to a value for it, but `checker.getResolvedSignature` on the
   * `CallExpression` invoking it has already committed -- that is what
   * resolving a call site over an overload set and inferring its type
   * arguments both mean. Building the shape from the resolved signature
   * instead of the property is exact for this one call, not an approximation:
   * the language itself performed this exact substitution to type-check the
   * call, and this reads that answer back rather than redoing the inference.
   */
  readonly resolvedSignatureTypeOf: (signature: ts.Signature, kind: 'call' | 'construct', resultOverride?: ts.Type) => StructuralTypeId
  /**
   * The raw `ts.Type` `typeAt` resolves a node to, one step before interning.
   * `producers/invocations.ts`'s `buildSelectedSignature` is the one caller:
   * a call's `SelectedSignature.returnType` and that SAME call's own
   * published result (`resultType`, via `context.types.typeAt(node)`) are
   * two computations of one fact, and `validateInvocationResult` refuses the
   * program when they disagree. `buildSelectedSignature` already tries the
   * checker's own answer and `context.returns` (the DECLARATION's own
   * return-statement census) first; once both are unusable evidence -- a
   * generic default collapsing the checker's answer to `any`, and no
   * function body for `context.returns` to read at all (hono's `H` resolves
   * to an abstract call-signature member, not a declaration with `return`s)
   * -- only this node-level, CALL-SITE census may still have a real answer,
   * and building a signature shape needs a raw `ts.Type` override, not
   * `typeAt`'s interned id. This is that same resolution
   * (`absentSubstitutedTypeAt`) exposed, so the two sides can never derive a
   * different answer for one node.
   */
  readonly rawTypeAt: (node: ts.Node) => ts.Type
  /** The census's pre-default read type of an array-pattern element, when it bound one -- see `ParameterBindingCensus.patternReadTypeAt`. */
  readonly patternReadTypeAt: (element: ts.BindingElement) => ts.Type | null
  /**
   * Every node for which two of `structuralRules` both had an answer.
   *
   * Empty unless `GEA_STRUCTURAL_DISAGREEMENT` is set, and that is not a
   * convenience: collecting it asks rules the chain would have stopped before,
   * which INTERNS structural ids the compilation never needed and renumbers
   * every `gea_record_type_N` after them. So a run that publishes this list is
   * a run whose emitted C++ nobody may compare, so nothing on the normal path
   * publishes it.
   *
   * Shared by every specialization view, because a disagreement is a property
   * of the rule set, not of the copy that happened to ask.
   */
  readonly structuralDisagreements: readonly StructuralDisagreement[]
  /**
   * Rules caught answering for a form their `forms` does not claim.
   *
   * Empty unless `GEA_STRUCTURAL_FORM_AUDIT` is set, and non-empty is a defect
   * in the rule set itself, not in the program being compiled: a rule whose
   * declared domain is wrong is silently never asked for a whole syntactic
   * form. See `structuralFormAuditEnabled`.
   */
  readonly structuralFormViolations: readonly StructuralFormViolation[]
  /**
   * The copies of every generic class whose copies can differ in layout,
   * keyed by the class's root declaration id: each copy's ordinal with its
   * layout-relevant fillings folded to structural ids -- exactly the tail of
   * the class's constructor anchor key inside that copy. Read after typing
   * by the deriver (`physicalClassDeclarationOf`), which groups them by the
   * REPRESENTATION of those fillings and names each group by its lowest
   * ordinal. Empty for a class every one of whose copies agrees on its
   * relevant fillings; see `SpecializationCensus.copiesMayDifferInLayout`.
   */
  readonly classCopies: () => ReadonlyMap<DeclarationId, readonly ClassCopyKey[]>
}

/**
 * The TYPE PARAMETER a reference actually holds, where the checker answered
 * with its base constraint instead.
 *
 * `getTypeAtLocation` on a reference to a `T`-typed binding does not answer
 * `T`. TypeScript computes an APPARENT type for the reference so member
 * lookups and narrowing have a concrete shape to work against, and for an
 * unnarrowed generic that apparent type is the parameter's base constraint --
 * `object` inside hono's `json = <T extends JSONValue | {} | InvalidJSONValue>
 * (object: T) => ... JSON.stringify(object)` reads back as the whole
 * constraint union.
 *
 * That is an ERASURE of the monomorphization, and it disagrees with the cell:
 * the parameter's own declaration is typed `T`, which this copy substitutes to
 * what the call bound, so the binding held `{ hello: string }` while every
 * read of it published the constraint. A `binding-read-conversion` from a
 * record to a ten-armed union is not a conversion any backend should install
 * -- the two carriers describe one value, and only one of them is the value's
 * type.
 *
 * Answered only when the checker's type IS the constraint, object-identical.
 * A reference the flow analysis genuinely narrowed (`typeof object ===
 * 'string'`) reaches a different type, and that narrowing is real.
 */
const constraintErasedParameterAt = (checker: ts.TypeChecker, node: ts.Node): ts.Type | null => {
  if (!ts.isIdentifier(node)) return null
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
  if (!declaration) return null
  if (!ts.isParameter(declaration) && !ts.isVariableDeclaration(declaration)) return null
  if (declaration.name === node) return null
  const declared = checker.getTypeAtLocation(declaration)
  if ((declared.flags & ts.TypeFlags.TypeParameter) === 0) return null
  return checker.getBaseConstraintOfType(declared) === checker.getTypeAtLocation(node) ? declared : null
}

export const createStructuralMapper = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  table: StructuralTypeTable,
  instantiations: InstantiationCensus = emptyInstantiationCensus,
  specializations: SpecializationCensus = emptySpecializationCensus,
  parameters: ParameterBindingCensus = emptyParameterBindingCensus,
  absent: AbsentGlobalCensus = emptyAbsentGlobalCensus,
  collections: CollectionBindingCensus = emptyCollectionBindingCensus,
  bags: ObjectBagCensus = emptyObjectBagCensus,
  flow?: ValueFlowIndex,
  families: InterfaceFamilyCensus = emptyInterfaceFamilyCensus,
  moduleRecords: CommonJsModuleRecordCensus = emptyCommonJsModuleRecordCensus,
  declaredMembers: DeclaredMemberCensus = emptyDeclaredMemberCensus,
  isIntrinsicDescriptorCall: (call: ts.CallExpression) => boolean = () => false
): StructuralMapper => {
  const storageTypeOf = recordStorageFamilies(checker, flow, parameters)
  // One disagreement list for the WHOLE mapper, for the same reason the caches
  // below are shared: two rules answering for one node is a fact about the rule
  // set, and a per-view list would report it once per copy that asked.
  const disagreements: StructuralDisagreement[] = []
  // One recurrence stack for the WHOLE mapper: the unfolding it folds crosses specialization views.
  const aliasRecurrence = createAliasRecurrence<StructuralTypeId>(checker)
  // One table cache for the WHOLE mapper, for the same reason: a copy's member
  // types are a property of the copy, and every view that passes through it
  // asks the same question.
  const instantiatedMembersFor = createInstantiatedMembers(checker, specializations)
  // And one recurrence key for every view-independent cycle, for the same reason.
  const viewIndependentKeyOf = createViewIndependentRecurrence(checker)
  // The ids those cycles settled on, for every view: a view that enters the
  // same cycle at another member (`State` where the first entered at
  // `State[]`) closes it through these instead of interning a second copy.
  const sharedCompleted = new Map<ts.Type, StructuralTypeId>()
  // Every generic class's copies, for every view: a class's copies are the
  // program's, not a view's, and their fillings are closed types, so both
  // answers are the same from every view. `classCopyKeys` is what
  // `classCopies` publishes to the deriver.
  const classCopyKeys = new Map<DeclarationId, Map<number, ClassCopyKey>>()
  const views = new Map<string, StructuralMapper>()
  const mapperFor = (path: SpecializationPath, bindingPath: SpecializationPath = path): StructuralMapper => {
    // Keyed by the copy, owner included, never by the ordinals alone: `copyKeyOf` (identities.ts) says why.
    // Both paths are in the key: two views differing only in what they BIND
    // are two different answers, and sharing one memo hands the second
    // whichever the first settled.
    const key = `${identities.copyKeyOf(path)}|${identities.copyKeyOf(bindingPath)}`
    const cached = views.get(key)
    if (cached) return cached
    const built = buildMapper(
      checker,
      identities.forSpecialization(path),
      table,
      instantiations,
      specializations,
      path,
      bindingPath,
      mapperFor,
      parameters,
      absent,
      collections,
      bags,
      flow,
      storageTypeOf,
      families,
      moduleRecords,
      declaredMembers,
      isIntrinsicDescriptorCall,
      aliasRecurrence,
      instantiatedMembersFor(bindingPath),
      viewIndependentKeyOf,
      sharedCompleted,
      classCopyKeys,
      disagreements
    )
    views.set(key, built)
    return built
  }
  return mapperFor(rootSpecialization)
}

const buildMapper = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  table: StructuralTypeTable,
  instantiations: InstantiationCensus,
  specializations: SpecializationCensus,
  path: SpecializationPath,
  bindingPath: SpecializationPath,
  mapperFor: (path: SpecializationPath, bindingPath?: SpecializationPath) => StructuralMapper,
  parameters: ParameterBindingCensus,
  absent: AbsentGlobalCensus,
  collections: CollectionBindingCensus,
  bags: ObjectBagCensus,
  flow: ValueFlowIndex | undefined,
  storageTypeOf: (type: ts.Type) => ts.Type,
  families: InterfaceFamilyCensus,
  moduleRecords: CommonJsModuleRecordCensus,
  declaredMembers: DeclaredMemberCensus,
  isIntrinsicDescriptorCall: (call: ts.CallExpression) => boolean,
  aliasRecurrence: AliasRecurrence<StructuralTypeId>,
  instantiatedMembers: InstantiatedMembers,
  viewIndependentKeyOf: (type: ts.Type) => string | null,
  sharedCompleted: Map<ts.Type, StructuralTypeId>,
  classCopyKeys: Map<DeclarationId, Map<number, ClassCopyKey>>,
  disagreements: StructuralDisagreement[]
): StructuralMapper => {
  const {
    boundByPath,
    bindingOf: censusBindingOf,
    substituteTypeParameter
  } = createTypeParameterSubstitution(identities, instantiations, specializations, bindingPath)
  // A type under translation must resolve to its anchor rather than recursing:
  // `interface Node { next: Node }` would otherwise never terminate.
  const inProgress = new Map<ts.Type, StructuralTypeId>()
  const completed = new Map<ts.Type, StructuralTypeId>()
  /** Self-reference with no declared name to anchor on -- a recursive type alias. See `structural-self-reference.ts`. */
  const walking = new Set<ts.Type>()
  const selfReferential = new Set<ts.Type>()
  /**
   * Every memo an in-flight attempt has written, so an unwind can take them
   * back. A stale citation, not a missing one: an unwound frame's memos are
   * keyed by checker type and survive, and the shapes behind them were interned
   * with the ABANDONED anchor inside -- so the retry's correct answer sits in
   * the table unused while the first attempt's conclusion outranks it. lib.dom's
   * `window` is the standing case (`Window & typeof globalThis`, `Window`
   * abandoned partway through): mentioning it at all selected a carrier
   * containing `unresolved(...)`. `null` when nothing is in flight.
   */
  let journal: ts.Type[] | null = null
  const selfReferentialKeys = new Map<ts.Type, string>()

  const unresolved = (reason: string, fallback?: 'erased-type-expression'): StructuralTypeId =>
    table.intern({ kind: 'unresolved', reason, ...(fallback ? { fallback } : {}) })

  const { keyOfSymbol } = createLeafKeying(identities, checker)
  const { implicitReceiverOf, declaredMemberSignatureOf } = createReceiverResolver(checker, (node) => layoutTypeAt(node), declaredMembers)

  /**
   * The object half of a `T[K]`, resolved the way this copy resolves a bare `T`.
   *
   * The `TypeParameter` branch of `translate` answers a parameter in three
   * steps -- what this copy binds, what the program-wide census binds, and the
   * author's own DEFAULT -- and only the first of those reached here, so a
   * parameter answered by either of the other two carried a `T[K]` that had
   * nothing left to refuse with. hono's `class Hono<E extends Env = Env, ...>`
   * is the case: nothing writes `Hono<Something>`, so every `E['Bindings']` in
   * `hono-base.ts` and `context.ts` -- 96 obligations, the file's largest
   * single cluster -- asked about a parameter whose answer is its default,
   * `Env`, and got the refusal instead.
   *
   * The default is the language's own substitution, not a guess: a reference
   * that omits the argument IS the default, and the checker has already typed
   * every such reference that way. Answering `T[K]` with anything else would
   * put this layer and the checker into disagreement about one expression.
   *
   * A fourth step is NOT here but at the access itself
   * (`memberTypesThroughBound`): the declared upper bound. It belongs there
   * rather than here because the same rule answers a case this function's
   * shape cannot see -- an object type that is not a parameter at all.
   */
  const resolvedObjectType = (objectType: ts.Type): ts.Type => {
    const substituted = substituteTypeParameter(objectType)
    if (substituted !== objectType) return substituted
    if ((objectType.flags & ts.TypeFlags.TypeParameter) === 0) return objectType
    const symbol = objectType.getSymbol()
    const declaration = symbol ? identities.declarationOfSymbol(symbol) : null
    if (!declaration || !ts.isTypeParameterDeclaration(declaration) || !declaration.default) return objectType
    // The instantiated default where the checker has one -- see the type-parameter
    // branch of `translate` below for why the declaration node alone is wrong.
    return checker.getDefaultFromTypeParameter(objectType) ?? checker.getTypeFromTypeNode(declaration.default)
  }

  /**
   * `T & {}` with `T := A | B | undefined` is `(A & {}) | (B & {}) |
   * (undefined & {})`, which is `A | B`.
   *
   * TypeScript distributes an intersection over its union members when it
   * BUILDS one (`getIntersectionType`), so the checker never hands this
   * mapper an intersection with a union member of its own -- until a copy
   * substitutes a union for the type parameter the checker left in place.
   * tsc's `assertIsDefined<T>(value: T)` and `cast<TOut extends TIn, TIn>`
   * narrow `value` to `T & {}`, and every copy bound to a union read an
   * intersection with a union member, which no record layout can hold: ~400
   * rows of "no primitive for an intersection whose member is not a record
   * shape" on the tsc self-compile. This is the checker's own reduction,
   * applied after substitution: distribute, drop `unknown` and the empty
   * object type (both intersect as identity), and reduce a product that pairs
   * an absence with anything else, or two primitives of different domains, to
   * `never`, which the union then drops. Only an UNNAMED intersection
   * distributes: a declared one keeps its name as its layout anchor.
   */
  // A recursive declaration is deliberately visible by id before its shape
  // exists. It is an atomic member until the frame that reserved it completes
  // it; inspecting it here violates the table's anchor protocol, while
  // retaining its id in each distributed product preserves the recurrence.
  const closedShapeAt = (id: StructuralTypeId): StructuralShape | null => (table.isOpen(id) ? null : table.get(id).shape)

  const distributedIntersectionOf = (members: readonly StructuralTypeId[]): StructuralTypeId | null => {
    if (!members.some((member) => closedShapeAt(member)?.kind === 'union')) return null
    let products: StructuralTypeId[][] = [[]]
    for (const member of members) {
      const shape = closedShapeAt(member)
      const choices = shape?.kind === 'union' ? shape.members : [member]
      products = products.flatMap((product) => choices.map((choice) => [...product, choice]))
      if (products.length > 512) return null
    }
    const arms: StructuralTypeId[] = []
    for (const product of products) {
      const arm = reducedIntersectionOf(product)
      if (arm !== null && !arms.includes(arm)) arms.push(arm)
    }
    const only = arms[0]
    if (only === undefined) return typeOf(checker.getNeverType())
    return arms.length === 1 ? only : table.intern({ kind: 'union', members: arms })
  }

  /** One product of the distribution, reduced as the checker reduces an intersection; `null` is `never`. */
  const reducedIntersectionOf = (product: readonly StructuralTypeId[]): StructuralTypeId | null => {
    const isIdentity = (shape: StructuralShape): boolean =>
      (shape.kind === 'primitive' && shape.primitive === 'unknown') ||
      (shape.kind === 'object' && shape.members.length === 0 && shape.index.length === 0)
    const kept = [...new Set(product)].filter((member) => {
      const shape = closedShapeAt(member)
      return shape === null || !isIdentity(shape)
    })
    const first = product[0]
    if (kept.length === 0) return first ?? null
    const domains = kept.map((member) => {
      const shape = closedShapeAt(member)
      if (shape === null) return null
      if (shape.kind === 'primitive') return shape.primitive
      if (shape.kind === 'literal') return shape.primitive
      return null
    })
    if (domains.includes('never')) return null
    const primitives = new Set(domains.flatMap((domain) => (domain === null ? [] : [domain])))
    if (primitives.size > 1) return null
    const absent = [...primitives].some((domain) => domain === 'undefined' || domain === 'null' || domain === 'void')
    if (absent && kept.length > 1) return null
    const only = kept[0]
    if (kept.length === 1 && only !== undefined) return only
    if (kept.some((member) => closedShapeAt(member)?.kind === 'union')) return distributedIntersectionOf(kept)
    return table.intern({ kind: 'intersection', members: kept, declaration: null, resolved: null })
  }

  /**
   * The index half of `T[K]`, resolved the way `resolvedObjectType` resolves
   * the object half: the copy's binding first, then the parameter's own
   * constraint. `readPackageJsonField<K extends MatchingKeys<PackageJson,
   * string | undefined>>(json, fieldName: K): PackageJson[K]` (tsc's
   * moduleNameResolver.ts) is the shape -- the OBJECT is a plain interface
   * and only the index is a parameter, which the object-side substitution
   * alone never touched, so every copy refused "an indexed access whose
   * object type is still a type parameter" for an access whose object type
   * never was one. A copy bound to `"types"` reads `PackageJson["types"]`;
   * the value-use copy reads the constraint, the checker-evaluated union of
   * the matching keys, which `keysOf` enumerates as it does any literal
   * union. A union index is left as written for the same enumerator.
   */
  const resolvedIndexType = (indexType: ts.Type): ts.Type => {
    const substituted = substituteTypeParameter(indexType)
    if (substituted !== indexType) return substituted
    if ((indexType.flags & ts.TypeFlags.TypeParameter) === 0) return indexType
    const bound = checker.getBaseConstraintOfType(indexType)
    return bound && bound !== indexType ? bound : indexType
  }

  /**
   * Whether a type is, or contains, a form the checker left DEFERRED -- a
   * conditional it could not evaluate, an unresolved indexed access, a
   * substitution. Such a type's base constraint is a fallback rather than a
   * statement, which is the distinction `memberTypesThroughBound` turns on.
   */
  const carriesDeferredForm = (type: ts.Type, depth = 0): boolean => {
    if (depth > 8) return false
    const deferred = ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Substitution
    if ((type.flags & deferred) !== 0) return true
    if (type.isUnion() || type.isIntersection()) return type.types.some((part) => carriesDeferredForm(part, depth + 1))
    return false
  }

  /**
   * `T[K]`'s member types read off `T`'s declared UPPER BOUND, for the object
   * types whose own shape cannot answer.
   *
   * A bound is information, not its absence. `E extends Env` states that every
   * `E` this program can produce is an `Env`, so every `E['Bindings']` is one
   * of `Env['Bindings']`'s own members -- and answering with those is
   * answering with a type every instantiation's value satisfies, which is
   * exactly what a storage carrier has to be. The alternative was a bottom
   * carrier, which is not a cell at all.
   *
   * The case that forced it is not a naked parameter, which is why this is not
   * inside `resolvedObjectType`. hono's router chain substitutes `E` with a
   * growing INTERSECTION -- `IfAnyThenEmptyObject<E extends Env ? Env extends
   * E ? {} : E : E> & IfAnyThenEmptyObject<E2 ...> & {}`, one arm per `.get()`
   * in the program -- because every route returns a `Hono` whose environment
   * merges the last one's. Substitution resolves `E` to that intersection
   * perfectly well; what cannot answer `['Bindings']` is the intersection,
   * whose constituents are CONDITIONAL types the checker leaves deferred while
   * `E` is generic. Its base constraint is `{}`, the environment hono's own
   * `BlankEnv` states, and `{}` declares no `Bindings` -- so the access is
   * `undefined`, which is what `indexedAccessMemberTypes` already answers for
   * a missing key on a real object type.
   *
   * `getBaseConstraintOfType` rather than `getConstraintOfType`: a constraint
   * can itself be a type parameter (`<A, B extends A>`), and a carrier needs
   * the bound that is no longer one. A type with no constraint answers
   * `undefined` and the caller keeps its refusal -- nothing was stated, so
   * there is nothing to resolve against. `any`/`unknown` as the bound keeps it
   * too: those are answered above, where the object type itself is the top
   * type, and reaching them through a bound would turn "nothing is stated"
   * into a claim about members.
   */
  const memberTypesThroughBound = (objectType: ts.Type, indexType: ts.Type): readonly ts.Type[] | null => {
    const bound = checker.getBaseConstraintOfType(objectType)
    if (!bound || bound === objectType) return null
    if ((bound.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
    // An EMPTY bound over a DEFERRED type states nothing, and must not be read
    // as stating absence. `indexedAccessMemberTypes` answers a missing key with
    // `undefined` -- the language's own answer, and the right one for a real
    // object type that genuinely declares no such member. `{}` arrived at as
    // the constraint of a conditional the checker could not evaluate is a
    // different fact wearing the same shape: it is TypeScript's fallback, not
    // the author's claim. hono's `env: E['Bindings'] = {}` is where the two
    // part company -- in the copy whose object type is the router chain's
    // intersection of deferred conditionals, absence would carrier the field as
    // `undefined`, a cell that provably cannot hold the initializer written on
    // the very same line. `unknown` is what is actually known there, and it is
    // a cell.
    if (carriesDeferredForm(objectType) && bound.getProperties().length === 0 && checker.getIndexInfosOfType(bound).length === 0) {
      return [checker.getUnknownType()]
    }
    return indexedAccessMemberTypes(checker, bound, indexType)
  }

  // `getMinArgumentCount` is checker-internal. The public answer is the count of
  // leading parameters the call site must supply: everything before the first
  // optional, defaulted, or rest parameter.
  const { signatureOf, memberOf, indexesOf, tupleElementsOf } = createStructuralParts({
    parameters,
    checker,
    identities,
    typeOf: (type) => typeOf(type),
    parameterOverrideAt: (parameter) => refusedArrayParameterTypeAt(parameter) ?? prototypeObjectParameterTypeAt(parameter),
    implicitReceiverOf,
    declaredMemberSignatureOf,
    declaredMembers,
    keyOfSymbol,
    // Same wrap the body-side rest-parameter reference below performs
    // (`table.intern({ kind: 'array', element: typeOf(restElement), ... })`)
    // exposed to `structural-parts.ts`'s `parameterOf`, which has no `table`
    // of its own -- see `StructuralPartsInput.internArray`'s doc.
    internArray: (element) => table.intern({ kind: 'array', element, readonly: false, extension: [] }),
    internUnion: (members) => table.intern({ kind: 'union', members }),
    // So `memberOf` can close the same keyed-collection-field gap `typeAt`
    // closes for every other node shape naming the same cell -- see
    // `StructuralPartsInput.collections`'s own doc.
    collections,
    table,
    // The bag census the collection value slot needs -- see
    // `StructuralPartsInput.bags`.
    bags
  })

  const { keeperFor } = createMemberRules(identities)

  /**
   * The shape of a type the LANGUAGE indexes -- a tuple or an Array -- or
   * `null` for anything else.
   *
   * Factored out because there are two places a type can be shaped, and only
   * one of them used to ask this. `Array<T>`'s own members mention
   * `Array<T>` (`concat`, `slice`, `filter` all return one), so an array
   * reached mid-walk is SELF-REFERENTIAL, and the self-referential branch
   * anchored it and then handed it to `buildDeclaredShape` -- which builds
   * the interface's data-only projection, `{ length, [Symbol.unscopables],
   * [number]: T }` with every method dropped. `remember` then cached that
   * against the very `ts.Type` the array branch below owns, so every later
   * mention of the same array got the projection too, and the array branch
   * was never reached again.
   *
   * Reached that way, `Object3D[]` carried as a `native-record-ref`:
   * CubeCamera's `const [ cameraPX, ... ] = cameras` asked for a
   * `destructuring:array-pattern:native-record-ref` helper no manifest
   * claims or should. Measured on the three.js app, 34 shapes and 52 selected
   * carriers were Array projections of this kind, against 4258 honest
   * `array-object` carriers -- an ordering leak, not a systemic
   * misclassification, which is exactly why it survived: most arrays are
   * reached from a position that asks the array branch first.
   *
   * `readonly` is `false` for the array case, as it has always effectively
   * been: the old expression was `isArrayLikeType(type) && !isArrayType(type)`
   * evaluated INSIDE an `isArrayType` branch, so it could not be anything
   * else. A `readonly T[]` is `ReadonlyArray<T>`, which `isArrayType` answers
   * `false` for and which reaches neither this helper nor that branch.
   */
  const indexedShapeOf = (type: ts.Type): StructuralShape | null => {
    if (checker.isTupleType(type)) {
      const reference = type as ts.TupleTypeReference
      return { kind: 'tuple', elements: tupleElementsOf(reference), readonly: reference.target.readonly }
    }
    if (!checker.isArrayType(type)) return null
    const element = checker.getTypeArguments(type as ts.TypeReference)[0]
    if (!element) return { kind: 'unresolved', reason: 'array type without an element type argument' }
    return { kind: 'array', element: typeOf(element), readonly: false, extension: [] }
  }

  /**
   * Whether an interface's heritage reaches the standard `Array` or
   * `ReadonlyArray`, through any chain of source interfaces.
   */
  const reachesStandardArray = (target: ts.InterfaceType, anchor: ts.Node, visited: Set<ts.Type>): 'array' | 'readonly-array' | null => {
    if (visited.has(target)) return null
    visited.add(target)
    for (const base of checker.getBaseTypes(target)) {
      if (isStandardInterfaceType(checker, anchor, 'Array', base)) return 'array'
      if (isStandardInterfaceType(checker, anchor, 'ReadonlyArray', base)) return 'readonly-array'
      // `ConcatArray<T>` is the third spelling of the same object, not a
      // separate shape -- see `arrayHeritageShapeOf`'s own note on why it is
      // recognized directly rather than through heritage.
      if (isStandardInterfaceType(checker, anchor, 'ConcatArray', base)) return 'readonly-array'
      const baseTarget = (base as ts.TypeReference).target ?? base
      if (!((baseTarget as ts.ObjectType).objectFlags & ts.ObjectFlags.Interface)) continue
      const reached = reachesStandardArray(baseTarget as ts.InterfaceType, anchor, visited)
      if (reached) return reached
    }
    return null
  }

  /** Whether a property is one the standard `Array`/`ReadonlyArray` interfaces themselves declare. */
  const isStandardArrayMember = (property: ts.Symbol): boolean =>
    (property.declarations ?? []).some((declaration) => {
      const owner = declaration.parent
      return (
        ts.isInterfaceDeclaration(owner) &&
        owner.getSourceFile().isDeclarationFile &&
        (owner.name.text === 'Array' || owner.name.text === 'ReadonlyArray' || owner.name.text === 'ConcatArray')
      )
    })

  /**
   * A BRAND on an array-extending interface -- `" __sortedArrayBrand": any`
   * (TypeScript's `SortedReadonlyArray<T>`) -- names no storage: its type
   * admits no value a program could write, and its name is spelled to be
   * unwritable. The object deriver's `isVacuousBrand` makes the same call for
   * intersections; here the member is simply not part of the extension.
   */
  const isArrayBrandMember = (property: ts.Symbol, location: ts.Node): boolean => {
    const name = property.getName()
    if (!(name.startsWith(' ') || name.startsWith('__'))) return false
    const flags = checker.getTypeOfSymbolAtLocation(property, location).flags
    return (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.UniqueESSymbol)) !== 0
  }

  /**
   * An interface whose heritage reaches the standard `Array`/`ReadonlyArray`
   * -- TypeScript's own `NodeArray<T> extends ReadonlyArray<T>,
   * ReadonlyTextRange` -- is an ARRAY with extra fields, not an object that
   * happens to carry the array's members as storage. Enumerated as an object
   * it interned `map<U>`, `filter<S>` and the rest as fields whose type
   * parameters no copy ever binds (230 "type parameter ... reached
   * representation without monomorphization" rows on the tsc self-compile,
   * one shape), and the deriver laid out a record for a value every consumer
   * indexes and iterates.
   *
   * The element is the INSTANTIATED number-index type, so `NodeArray<T>` read
   * inside a generic copy still resolves `T` through that copy exactly as
   * `T[]` does. The extension is the interface's own data members -- every
   * property the array interfaces do not themselves declare, so a second base
   * (`ReadonlyTextRange`'s `pos`/`end`) contributes too -- minus brand
   * members, which state nothing storable. `readonly` stays `false` for the
   * same reason `indexedShapeOf` keeps it so: `Array` and `ReadonlyArray`
   * heritage must intern to ONE shape, since `MutableNodeArray<T>` and
   * `NodeArray<T>` are the same object under two spellings.
   */
  const arrayHeritageShapeOf = (type: ts.Type, location: ts.Node): StructuralShape | null => {
    if (!(type.flags & ts.TypeFlags.Object)) return null
    const object = type as ts.ObjectType
    const target = object.objectFlags & ts.ObjectFlags.Reference ? (type as ts.TypeReference).target : object
    if (!(target.objectFlags & ts.ObjectFlags.Interface)) return null
    // `ConcatArray<T>` is the one standard array interface that reaches
    // neither `Array` nor `ReadonlyArray` through heritage: `lib.es5.d.ts`
    // declares it standalone, with `readonly length`, `readonly [n: number]:
    // T`, `join` and `slice`, and `Array<T>`/`ReadonlyArray<T>`/every tuple
    // satisfy it structurally. It is a SPELLING of the array object, not an
    // object that happens to carry an array's members, and it is where every
    // `Array.prototype.concat(...items: ConcatArray<T>[])` argument lands --
    // so deriving it as a record made `a.concat(b)` refuse the rest pack it
    // had just built (`conversion:array-object(E)->native-record-ref`), for
    // every element type, in every program. hono's `RegExpRouter`
    // (`Object.keys(a).concat(Object.keys(b))`) and its trie router
    // (`tempNodes.concat(shifted)`) are the two that named it.
    if (
      !reachesStandardArray(target as ts.InterfaceType, location, new Set()) &&
      !isStandardInterfaceType(checker, location, 'ConcatArray', type)
    )
      return null
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    if (!element) return null
    const extension: StructuralMember[] = []
    for (const property of creationOrderedProperties(checker, type, parameters)) {
      if (isStandardArrayMember(property) || isArrayBrandMember(property, location)) continue
      const member = memberOf(property, location)
      if (member) extension.push(member)
    }
    return { kind: 'array', element: typeOf(element), readonly: false, extension }
  }

  const objectShapeOf = (type: ts.Type, location: ts.Node | null, members: MemberMode = 'all'): StructuralShape => {
    const properties = creationOrderedProperties(checker, type, parameters)
    const kept = members === 'all' ? properties : properties.filter(keeperFor(properties, members))
    const mapped = kept.flatMap((property) => {
      const member = memberOf(property, location)
      return member ? [member] : []
    })
    const indexes = [...indexesOf(type)]
    if (location && ts.isObjectLiteralExpression(location) && members === 'all') {
      const runtimeMembers = mapped.filter((member) => {
        if (member.key.kind !== 'symbol' || member.accessor !== null) return false
        const keyDeclarationId = member.key.declaration
        const property = kept.find((candidate) => {
          const keyDeclaration = symbolKeyDeclarationOf(checker, identities, candidate)
          return keyDeclaration !== null && identities.declarationIdOf(keyDeclaration) === keyDeclarationId
        })
        const declarations = property?.declarations
        return !!declarations?.length && declarations.every(ts.isPropertyAssignment) && !declarations[0]!.getSourceFile().isDeclarationFile
      })
      if (runtimeMembers.length) {
        const existing = indexes.findIndex((index) => index.key === 'symbol')
        const prior = existing < 0 ? undefined : indexes[existing]
        const values = [...new Set([...runtimeMembers.map((member) => member.type), ...(prior ? [prior.value] : [])])]
        const value = values.length === 1 ? values[0]! : table.intern({ kind: 'union', members: values })
        const index = {
          key: 'symbol' as const,
          value,
          readonly: false,
          runtimeMembers: runtimeMembers.flatMap((member) => (member.key.kind === 'symbol' ? [member.key.declaration] : [])),
          finite: prior === undefined
        }
        if (existing < 0) indexes.push(index)
        else indexes[existing] = index
      }
    }
    return {
      kind: 'object',
      members: mapped,
      index: indexes,
      membersDropped: kept.length !== properties.length
    }
  }

  /**
   * The structure a declared name stands for.
   *
   * A name without a body is a name the later layers cannot lay out, so the body
   * is interned here while the nominal identity is still anchored -- a member
   * that refers back to the declaration resolves to the anchor instead of
   * re-entering translation.
   */
  /**
   * The storage a class instance owns.
   *
   * Only `Property` members: a method and an accessor live on the prototype, so
   * putting either in the instance's structure would claim per-instance storage
   * the language does not allocate, and every instance would carry a copy of
   * every method. A field that happens to hold a function (`onClick = () => {}`)
   * *is* per-instance storage, and the symbol flags are what tell the two apart
   * -- not the type of the value they hold.
   */
  const classInstanceBodyOf = (type: ts.Type, location: ts.Node): StructuralTypeId | null => {
    // A class declared in a declaration file is enumerated like any other. Its
    // *fields* are data, and a subclass this program does define inherits them
    // -- refusing the layout would leave that subclass with no carrier at all.
    // What the program genuinely cannot do with such a class is construct one or
    // call one of its methods, and both of those refuse where they happen: the
    // construction has no body to run, and a method key resolves to no callable.
    const shape = objectShapeOf(type, location, 'data-only')
    // `objectShapeOf` walks `type.getProperties()` -- the checker's OWN
    // member table -- which is blind to a field installed only through a
    // `const _this = this` alias (`source-class-data.ts`'s
    // `constructorInstalledMemberWritesOf` says why the checker never learns
    // one). Without this, such a field got no struct member at all, and every
    // read/write of it fell back to the fully dynamic `gea_readOwnField`/
    // `gea_writeOwnField` expando protocol -- the closure PROOF for a call
    // reached through it could still certify (that fallback fixed the flow-
    // index side, in `source-class-data.ts`), but the emitted storage stayed
    // boxed. `flow` is only absent for a handful of callers that never had a
    // constructor-function/class-alias question to ask in the first place
    // (see `buildMapper`'s `flow?: ValueFlowIndex`); `ts.isClassLike` matches
    // this function's one call site, gated the same way at `declaredAnchorOf`.
    if (flow && ts.isClassLike(location) && shape.kind === 'object') {
      const installed = constructorInstalledMemberDeclarationsOf(flow, location)
      if (installed.size > 0) {
        const existing = new Set(shape.members.flatMap((member) => (member.key.kind === 'string' ? [member.key.value] : [])))
        const extra: StructuralMember[] = []
        for (const [key, declarations] of installed) {
          if (existing.has(key)) continue
          const values = [...new Set(declarations.map((declaration) => typeOf(checker.getTypeAtLocation(declaration.right))))]
          extra.push({
            key: { kind: 'string', value: key },
            type: values.length === 1 ? values[0]! : table.intern({ kind: 'union', members: values }),
            optional: false,
            readonly: false,
            accessor: null
          })
        }
        if (extra.length > 0) return table.intern({ ...shape, members: [...shape.members, ...extra] })
      }
    }
    return table.intern(shape)
  }

  const { declaredBodyOf } = createDeclaredBodyResolver({ table, typeOf, signatureOf, objectShapeOf, arrayHeritageShapeOf })

  /** The nominal identity of a declared type, before its arguments or body are known. */
  interface DeclaredAnchor {
    readonly kind: 'declared' | 'class-constructor' | 'class-instance'
    readonly declaration: DeclarationId
    readonly declarationNode: ts.Node
  }

  const declaredAnchorOf = (type: ts.Type): DeclaredAnchor | null => {
    // `type Img = { imageId: number; describe(): number }` -- a type alias to
    // an anonymous object-literal type -- has its OWN symbol answer the
    // anonymous `__type` symbol pointing at the `TypeLiteral` node, not the
    // `TypeAliasDeclaration`, because that is genuinely what `type.getSymbol()`
    // returns for an alias to an object literal type (verified against the
    // checker directly). The `?? type.aliasSymbol` fallback below therefore
    // never fires for this one specific shape, and `Img` never gets the
    // `declared` nominal anchor an `interface Img {...}` gets for the
    // identical body -- two spellings of the same kind of declaration ending
    // up with two different identity treatments. Preferring `aliasSymbol`
    // whenever the own symbol resolves to a `TypeLiteral` (rather than always
    // preferring it, which would wrongly re-route `type X = SomeInterface`
    // away from `SomeInterface`'s own, already-correct anchor) makes `Img`
    // resolve through the alias exactly like `interface Img` does, without
    // changing any other declared type's resolution.
    //
    // ⛔ A MAPPED type is deliberately NOT treated as anonymous here, and this
    // was measured both ways. `Record<K, V>` is `type Record<K, T> = { [P in
    // K]: T }`, so an instantiation's own symbol answers the anonymous
    // `__type` of that `MappedTypeNode` rather than the `TypeAliasDeclaration`
    // -- which means a type recursing THROUGH a mapped alias has no
    // declaration to break the cycle on, and hono's `class Node { #children:
    // Record<string, Node> }` (`router/reg-exp-router/node.ts`) refuses as `a
    // self-referential type of this shape is not modelled`. Routing such a
    // type through the ALIAS instead does fix that, and it costs
    // `examples/weather` its whole certificate: with the alias as the anchor,
    // a host-bound member reached through a mapped type demands
    // `native-boundary:__type@1`, a protocol nothing registers. Net on hono
    // once `router/reg-exp-router` stopped being reachable at all (see
    // `reachability.ts`'s type-only import rule) it was WORSE by two
    // obligations as well, so there is nothing left on the other side of the
    // trade. A cycle through a mapped alias needs `selfReferentialShapeOf` to
    // model that shape, not a second nominal anchor for it -- which is what it
    // now does: its dictionary case closes `Record<string, Node>` on the
    // anchor the retry already reserved, leaving this decision untouched.
    const ownSymbol = type.getSymbol()
    const ownDeclaration = ownSymbol ? identities.declarationOfSymbol(ownSymbol) : null
    const anonymous = ownDeclaration !== null && (ts.isTypeLiteralNode(ownDeclaration) || ts.isJSDocTypeLiteral(ownDeclaration))
    const symbol = (anonymous ? type.aliasSymbol : null) ?? ownSymbol ?? type.aliasSymbol
    if (!symbol) return null
    const declaration = identities.declarationOfSymbol(symbol)
    if (!declaration) return null
    // At the ROOT path, deliberately, and never at the copy this walk happens
    // to be inside. `identities` is a per-copy VIEW (`identities.ts`'s
    // `declarationIdOf: (declaration, override) => ... prefixFor(declaration,
    // path)`), so asking it without an override mints `decl|f77|148` from a
    // root walk and `decl|f77|148@0` from a copy's -- two nominal anchors for
    // ONE declaration, and therefore two structural shapes, two `class-ref`
    // carriers and two C++ struct names (`cppTypeOf` spells a class-ref as
    // `cppClassName(representation.declaration)`).
    //
    // Which copy a walk was in is not part of a nominal type's identity. What
    // IS part of it -- the instantiation's own type arguments -- is already in
    // the anchor key below, folded through `layoutRelevantParameterIndices` so
    // that two instantiations differing only in a phantom parameter share one
    // physical layout. The copy path says nothing the arguments do not, and
    // saying it twice is what split hono's `Context` and `Hono` into a
    // root-cited half and a copy-cited half whose members only one of the two
    // could ever find.
    const id = identities.declarationIdOf(declaration, rootSpecialization)
    if (ts.isClassLike(declaration)) {
      // A class's constructor object and its instances are different values with
      // different members; merging them loses `new` semantics entirely.
      const isConstructorSide = type.getCallSignatures().length + type.getConstructSignatures().length > 0
      return { kind: isConstructorSide ? 'class-constructor' : 'class-instance', declaration: id, declarationNode: declaration }
    }
    // A JSDoc `@typedef {object} Node` is a declared name just as an
    // `interface Node` is. The checker's own type for it has the synthetic
    // JSDoc type-literal as its symbol and the typedef as `aliasSymbol`, so
    // stopping here would re-enter the anonymous object through `Node[]` and
    // lose the only finite native layout. The alias declaration is the stable
    // checker identity that closes that cycle; this is declaration-kind
    // parity, not a protocol for a particular JSDoc library.
    if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isJSDocTypedefTag(declaration) ||
      ts.isEnumDeclaration(declaration)
    ) {
      return { kind: 'declared', declaration: id, declarationNode: declaration }
    }
    // A pre-`class` JavaScript CONSTRUCTOR FUNCTION's instances are nominal,
    // and named by the function: `function WebGLClipping( properties ) {
    // this.uniform = uniform; ... }` gives TypeScript's own JS inference a
    // construct signature whose return type it prints as `WebGLClipping`,
    // symboled to the function declaration itself. Anchoring it here is what
    // lets that type be SELF-REFERENTIAL, which every one of these is: the
    // instance carries `this.setState = function ( material ) { ... }`, whose
    // own receiver is the instance (`structural-receiver.ts`'s
    // `jsConstructorReceiverOf`). Reached anonymously the walk collides with
    // itself and `selfReferentialShapeOf` models no object shape with NAMED
    // members (its dictionary case is index-only on purpose, because the
    // retry cannot reach the location-aware member walk), so the whole
    // instance -- every field, every method -- refuses as `a self-referential
    // type of this shape is not modelled`; anchored, the member that refers
    // back resolves to the anchor, exactly as a class instance's does.
    //
    // The INSTANCE side only. The function's own type has the same symbol, and
    // it is not a declared name for a structure: it is the callable, whose
    // carrier is `function-and-constructor`. The split is the one
    // `ts.isClassLike` above makes for the identical reason -- a constructor
    // object and its instances are different values with different members --
    // told apart the same way, by whether the type carries a signature.
    if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) {
      if (type.getCallSignatures().length + type.getConstructSignatures().length > 0) return null
      return { kind: 'declared', declaration: id, declarationNode: declaration }
    }
    return null
  }

  /**
   * The body of a `declared`/`class-constructor`/`class-instance` anchor,
   * once its type arguments are already in hand.
   *
   * Shared between the ordinary declared-anchor path (`translate`, below) and
   * the self-referential retry (`typeOf`'s `selfReferential` branch): a class
   * whose OWN type argument mentions the class again -- `Object3D<EventMap>`
   * where `EventMap` describes an event carrying `Object3D<EventMap>` as its
   * target, exactly what three.js's own `Object3DEventMap` does -- cannot
   * compute this anchor's key up front, because the key needs the argument's
   * structural id and deriving that id is what re-enters the class. That is a
   * genuine cycle, not an undeclared shape: the retry mechanism already
   * detects it and reserves an anchor before calling this, at which point
   * `checker.getTypeArguments(...).map(typeOf)` re-entering the same class
   * resolves through that anchor (`inProgress`) instead of recursing. Only
   * the ordinary path's *key* depends on having the type arguments already
   * -- the *body* this function builds does not care which path reserved its
   * anchor.
   */

  /**
   * The one layout every interface of a family shares -- `interface-families.ts`
   * says why the layout follows the object rather than the view. Each member
   * is enumerated through `objectShapeOf` exactly as a lone interface's body
   * is, then the members merge by key: a field is required only where every
   * member of the family declares it required (an object of the family may
   * lack it otherwise, and `memberOf`'s own rule applies -- the absence has
   * to be in the TYPE, since that is all a field's carrier derives from), and
   * its type is the union of what the members declare, flattened, so that
   * `Identifier` beside `Identifier | undefined` is one three-state union and
   * not a union nesting a union, which `union.ts` would carry as two arms of
   * one carrier.
   *
   * Reserved as an ANCHOR before any member is walked: a member's own field
   * types name family-mates (`Node.parent: Node`, `SourceFile.statements:
   * NodeArray<Statement>`), each a declared anchor whose body is this same
   * layout, so the walk re-enters here with the reservation made and reads
   * the id back instead of recursing. Abandoned on an unwind for the reason
   * `typeOfWalk` abandons its own: the retry re-reserves under the same key.
   */
  const familyBodyOf = (declared: DeclaredAnchor): StructuralTypeId | null => {
    if (declared.kind !== 'declared' || !ts.isInterfaceDeclaration(declared.declarationNode)) return null
    const family = families.familyOf(declared.declaration)
    if (!family) return null
    const { id, fresh } = table.anchor(`interface-family:${family.key}`)
    if (!fresh) return id
    let settled = false
    try {
      table.complete(id, familyLayoutOf(family))
      settled = true
    } finally {
      if (!settled) table.abandon(id)
    }
    return id
  }

  /**
   * The one family member an intersection NARROWS, when that is all it does.
   *
   * tsc's type guards return `node is CallExpression & { expression:
   * Identifier; arguments: [StringLiteralLike] }` and `node is
   * BinaryExpression & { operatorToken: AssignmentOperatorToken }`
   * (`isRequireCall`, `isAssignmentExpression`, ...): the checker narrows
   * `node` to an intersection of a family member with an object literal
   * type that restates some of the member's own fields more precisely. The
   * value is the same object -- there is exactly one `Node` allocation, and
   * the family exists so that every view of it is ONE layout -- but the
   * intersection interned as its own shape below, whose `resolved` image is
   * a fresh record with every field required, so every guarded read asked
   * for `native-record-ref(family) -> record(...)`, a conversion that would
   * copy an object the program still holds by identity (72 rows over
   * `utilities.ts`, `checker.ts`, `utilitiesPublic.ts`).
   *
   * Admitted only where the intersection adds nothing to the object: every
   * non-family member is an anonymous object literal type with no index,
   * call or construct signature, and every property it names is a field the
   * family already declares. A brand (`& { __x: unique symbol }`) or a new
   * field is a different type and keeps the general path. Two family
   * members of the same family are the same layout (`Expression &
   * Declaration`); members of different families are not one object.
   */
  const familyFieldNames = new Map<DeclarationId, ReadonlySet<string>>()
  const familyMemberNarrowedBy = (type: ts.IntersectionType): StructuralTypeId | null => {
    const member = narrowedFamilyMemberOf(type)
    return member === null ? null : typeOf(member)
  }
  const narrowedFamilyMemberOf = (type: ts.IntersectionType): ts.Type | null => {
    let family: InterfaceFamily | null = null
    let member: ts.Type | null = null
    const narrowings: ts.Type[] = []
    for (const part of type.types) {
      const anchor = declaredAnchorOf(part)
      const own =
        anchor?.kind === 'declared' && ts.isInterfaceDeclaration(anchor.declarationNode) ? families.familyOf(anchor.declaration) : null
      if (own) {
        if (family !== null && own !== family) return null
        family = own
        member ??= part
        continue
      }
      if ((part.flags & ts.TypeFlags.Object) === 0 || ((part as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) === 0) return null
      if ((part.getSymbol()?.declarations ?? []).some((declaration) => !ts.isTypeLiteralNode(declaration))) return null
      narrowings.push(part)
    }
    if (family === null || member === null) return null
    let names = familyFieldNames.get(family.key)
    if (!names) {
      const collected = new Set<string>()
      for (const declaration of family.members) {
        const symbol = checker.getSymbolAtLocation(declaration.name)
        if (!symbol) continue
        for (const property of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) collected.add(property.getName())
      }
      names = collected
      familyFieldNames.set(family.key, names)
    }
    for (const part of narrowings) {
      if (checker.getIndexInfosOfType(part).length > 0 || part.getCallSignatures().length > 0 || part.getConstructSignatures().length > 0)
        return null
      if (!checker.getPropertiesOfType(part).every((property) => names.has(property.getName()))) return null
    }
    return member
  }

  const familyLayoutOf = (family: InterfaceFamily): StructuralShape => {
    interface MergedField {
      readonly key: StructuralMember['key']
      readonly types: StructuralTypeId[]
      declaredBy: number
      requiredBy: number
      readonlyBy: number
    }
    // An open anchor is a family-mate's (or another recursive type's) body
    // still being built; it names one member and nothing to flatten.
    const flatten = (id: StructuralTypeId): readonly StructuralTypeId[] => {
      if (table.isOpen(id)) return [id]
      const shape = table.get(id).shape
      return shape.kind === 'union' ? shape.members.flatMap(flatten) : [id]
    }
    const merged = new Map<string, MergedField>()
    for (const member of family.members) {
      const symbol = checker.getSymbolAtLocation(member.name)
      if (!symbol) continue
      const shape = objectShapeOf(checker.getDeclaredTypeOfSymbol(symbol), member, 'all')
      if (shape.kind !== 'object') continue
      for (const field of shape.members) {
        if (field.accessor !== null) continue
        const keyText = JSON.stringify(field.key)
        const slot = merged.get(keyText) ?? { key: field.key, types: [], declaredBy: 0, requiredBy: 0, readonlyBy: 0 }
        if (!merged.has(keyText)) merged.set(keyText, slot)
        for (const part of flatten(field.type)) if (!slot.types.includes(part)) slot.types.push(part)
        slot.declaredBy += 1
        if (!field.optional) slot.requiredBy += 1
        if (field.readonly) slot.readonlyBy += 1
      }
    }
    const undefinedType = typeOf(checker.getUndefinedType())
    const members: StructuralMember[] = [...merged.values()].map((slot) => {
      const optional = slot.requiredBy < family.members.length
      const types = optional && !slot.types.includes(undefinedType) ? [...slot.types, undefinedType] : slot.types
      const only = types.length === 1 ? types[0] : undefined
      return {
        key: slot.key,
        type: only ?? table.intern({ kind: 'union', members: types }),
        optional,
        readonly: slot.readonlyBy === slot.declaredBy,
        accessor: null
      }
    })
    return { kind: 'object', members, index: [], membersDropped: false }
  }

  const erasedTypeArgument = () => table.intern({ kind: 'primitive', primitive: 'any' })

  /**
   * The class copy this view is inside, or `null` when the view binds no copy
   * of it.
   *
   * The LAST step naming the class wins, which is the precedence
   * `createPathBinding` (structural-generics.ts) already gives the type
   * parameters that step binds. A path can name one owner twice --
   * `copyPathOf` appends the copy a site names onto the copy the site sits
   * inside, so `new Box<R>(...)` written inside `Box<T>` is walked at
   * `[Box#0, Box#1]` -- and taking the first there bound `T` from one copy
   * while calling the other's constructor object a `Box<T>`.
   */
  const copyOfClassInPath = (
    owner: ts.ClassLikeDeclaration
  ): { readonly ordinal: number; readonly arguments: readonly ts.Type[] } | null => {
    for (let index = bindingPath.length - 1; index >= 0; index -= 1) {
      const step = bindingPath[index]
      if (!step || step.owner !== owner) continue
      const copy = specializations.specializationsOf(owner)[step.ordinal]
      return copy ? { ordinal: copy.ordinal, arguments: copy.arguments } : null
    }
    return null
  }

  /**
   * The copy of the class this view is inside, with its fillings folded
   * through the class's layout-relevant indices exactly as the instance
   * anchor folds a written instantiation -- the arguments the copy's
   * constructor object is read AT. `null` when the view is inside no copy
   * of the class. Recorded against the copy's ordinal for the deriver
   * (`classCopies`) once the anchor is reserved, by `recordClassCopy`.
   */
  const foldedCopyOf = (
    owner: ts.ClassLikeDeclaration,
    layoutRelevant: ReadonlySet<number> | null
  ): { readonly ordinal: number; readonly typeArguments: readonly StructuralTypeId[] } | null => {
    const copy = copyOfClassInPath(owner)
    if (!copy) return null
    return {
      ordinal: copy.ordinal,
      typeArguments: copy.arguments.map((argument, index) =>
        layoutRelevant && !layoutRelevant.has(index) ? erasedTypeArgument() : typeOf(argument)
      )
    }
  }

  const recordClassCopy = (
    root: DeclarationId,
    ordinal: number,
    typeArguments: readonly StructuralTypeId[],
    constructor: StructuralTypeId
  ): void => {
    const known = classCopyKeys.get(root) ?? new Map<number, ClassCopyKey>()
    if (!known.has(ordinal)) known.set(ordinal, { ordinal, typeArguments, constructor })
    classCopyKeys.set(root, known)
  }

  const buildDeclaredShape = (type: ts.Type, declared: DeclaredAnchor, typeArguments: readonly StructuralTypeId[]): StructuralShape => {
    const { kind, declaration } = declared
    if (kind === 'declared') {
      return { kind, declaration, typeArguments, body: familyBodyOf(declared) ?? declaredBodyOf(type, declared.declarationNode) }
    }
    if (kind === 'class-constructor') {
      // An overloaded constructor's IMPLEMENTATION declares the one frame the
      // body runs with -- see `constructorImplementationSignatureOf`. Asked
      // before the checker's own answer below, which is every overload and no
      // single convention, exactly as `valueTypeAt` asks
      // `implementationSignatureOf` before the symbol-level answer for a
      // method's overload set.
      const implementation = constructorImplementationSignatureOf(checker, declared.declarationNode)
      const constructSignatures = implementation ? [implementation] : type.getConstructSignatures()
      return {
        kind,
        declaration,
        typeArguments,
        // The constructor object's calling convention is what `new` invokes;
        // a constructor value carrying no signature has no convention to
        // select, and every construction fails closed.
        construct:
          constructSignatures.length > 0
            ? table.intern({ kind: 'signature', call: [], construct: constructSignatures.map((one) => signatureOf(one)) })
            : null
      }
    }
    // A class reached only as a field type has no constructor event to publish
    // its base's storage. Intern that checker-authenticated ancestry here so
    // the final carrier closure can resolve it without flattening inheritance.
    if (type.isClassOrInterface()) for (const base of checker.getBaseTypes(type)) typeOf(base)
    return { kind, declaration, typeArguments, body: classInstanceBodyOf(type, declared.declarationNode) }
  }

  // `keyof` reads its answer back out of the sealed table, so the table is the
  // only thing it needs from this closure -- which is why it lives on its own.
  const keyofOfShapeId = createKeyofResolver(table)

  function typeOf(type: ts.Type): StructuralTypeId {
    // Assignment-connected record views must agree before any layout is
    // interned, including the element reached through an array or tuple.
    const storage = storageTypeOf(type)
    if (storage !== type) return typeOf(storage)
    // A mapped type that changes only modifiers is its SOURCE, physically --
    // see `modifierOnlyMappedSourceOf`. Answered before the alias-recurrence
    // guard, because the point is that there is no recursion here at all:
    // `Mutable<T>` never was a second object for the walk to re-enter.
    const modifierOnly = modifierOnlyMappedSourceOf(type)
    if (modifierOnly) return typeOf(modifierOnly)
    return aliasRecurrence.within(
      type,
      () => typeOfWalk(type),
      foldToAncestor,
      (reason) => unresolved(reason)
    )
  }

  /**
   * The id a recurring alias instantiation resolves to: its ancestor's, which
   * closes the cycle instead of unrolling it (`structural-alias-recurrence.ts`).
   * The cases are the three states the ancestor's own walk can be in; only the
   * last is new, and it reuses the retry a directly self-referential type takes.
   */
  function foldToAncestor(ancestor: ts.Type): StructuralTypeId {
    const done = completed.get(ancestor)
    if (done) return done
    const pending = inProgress.get(ancestor)
    if (pending) return pending
    if (walking.has(ancestor)) throw selfReferentialSignal(ancestor)
    return unresolved(
      `a recurring type alias ${ancestor.aliasSymbol?.name ?? '(unnamed)'} resolved to an ancestor whose own walk had already unwound`
    )
  }

  function typeOfWalk(type: ts.Type): StructuralTypeId {
    const done = completed.get(type)
    if (done) return done
    const shared = sharedCompleted.get(type)
    if (shared !== undefined) return remember(type, shared)
    const pending = inProgress.get(type)
    if (pending) return pending
    // Re-entered while its own walk is still running, with no anchor to resolve
    // to: unwind to that walk's own frame, which retries under an anchor.
    if (walking.has(type)) throw selfReferentialSignal(type)

    if (selfReferential.has(type)) {
      // `fresh` is the table's own answer to who owns this reservation. A walk
      // that did not create it must not complete it and must not abandon it:
      // the anchor is either finished already or being built by an outer frame,
      // and in both cases the id alone is the whole answer here.
      // The ordinal is local to this mapper view, while anchors live in the
      // compilation-wide table. Include both view paths so unrelated recursive
      // types cannot reuse another view's `self-referential:0`, and an open
      // type translated under different bindings keeps its own layout.
      // -- unless no binding can reach the type at all, in which case every
      // view closes the cycle at one anchor (`createViewIndependentRecurrence`).
      const sharedKey = viewIndependentKeyOf(type)
      const recurrenceKey =
        sharedKey ?? `${identities.copyKeyOf(path)}|${identities.copyKeyOf(bindingPath)}|${selfReferentialKeyOf(selfReferentialKeys, type)}`
      const { id: anchor, fresh } = table.anchor(recurrenceKey)
      if (!fresh) return remember(type, anchor)
      inProgress.set(type, anchor)
      walking.add(type)
      let settled = false
      let completedShape: StructuralShape = { kind: 'unresolved', reason: 'a self-referential type of this shape is not modelled' }
      try {
        // A declared name (class instance, class constructor, interface, type
        // alias) whose OWN type argument mentions it again -- see
        // `buildDeclaredShape`'s docstring for the concrete three.js case --
        // is not an anonymous cycle `selfReferentialShapeOf` needs to know a
        // fourth shape for: it is one of the three shapes the ordinary
        // declared-anchor path already builds, just reached through the one
        // path that cannot compute its own anchor key up front. The anchor
        // for `type` is already reserved above, so recomputing its type
        // arguments here resolves any mention of `type` itself through
        // `inProgress` instead of recursing.
        const declared = declaredAnchorOf(type)
        // An Array or a tuple is shaped as one HERE too, ahead of the
        // declared-name path -- see `indexedShapeOf`'s own comment for what
        // reaching this frame first used to cost. The anchor is already
        // reserved, so the element's own walk resolves a mention of `type`
        // through `inProgress` exactly as `buildDeclaredShape`'s does.
        const shape =
          bagShapeOfType(typeOf, bags, type) ??
          indexedShapeOf(type) ??
          (declared
            ? buildDeclaredShape(type, declared, typeArgumentsOf(type).map(typeOf))
            : selfReferentialShapeOf(checker, type, typeOf, tupleElementsOf, indexesOf, (one) =>
                selfReferentialCallableShapeOf(one, signatureOf)
              ))
        completedShape = shape ?? completedShape
        table.complete(anchor, completedShape)
        settled = true
      } finally {
        walking.delete(type)
        inProgress.delete(type)
        if (!settled) table.abandon(anchor)
      }
      // A cycle another view already closed, entered here at a different
      // member, reaches through `sharedCompleted` a shape the table holds
      // under an earlier id. That shape cites nothing of this walk -- one
      // citing the fresh anchor could equal no earlier shape -- so the
      // earlier id is the answer and the anchor stays uncited: one cycle,
      // one set of ids, whichever member a view happened to enter at.
      const canonical = table.intern(completedShape)
      if (sharedKey !== null) sharedCompleted.set(type, canonical)
      return remember(type, canonical)
    }

    walking.add(type)
    // Only the OUTERMOST attempt journals: the frame the signal names is the
    // one whose retry redoes the work.
    const outermost = journal === null
    const attempt: ts.Type[] = journal ?? []
    journal = attempt
    const mark = attempt.length
    try {
      return translate(type)
    } catch (error) {
      if (!isSelfReferentialSignal(error) || error.selfReferentialType !== type) throw error
      // Withdrawn before the retry: these name anchors that no longer exist.
      //
      // Deleting the `completed` memo is enough for anything this SAME walk
      // built by plain interning: a member id baked into its structural key,
      // so a shape that no longer resolves the same way mints a new id on its
      // own. It is not enough for a DECLARED type that finished its own build
      // successfully inside this failed attempt -- one that read a sibling
      // anchor's id while that sibling was still open (a legitimate
      // self-reference at the time, e.g. `MessageEvent.source` reading
      // `Window`'s in-progress anchor while `Window`'s own build was still
      // running). That declared type's OWN build never threw, so `translate`'s
      // finally never abandoned it; it is sitting there complete, citing an id
      // that is about to become an abandoned, unresolved stub. Its table KEY
      // has to be released too (`releaseKey`, a no-op for anything that is not
      // an anchor key), so the next `typeOf` call for it does not silently
      // reuse a shape built on a since-abandoned sibling and instead rebuilds
      // against whatever that sibling's retry actually resolves to.
      for (const remembered of attempt.slice(mark)) {
        const rememberedId = completed.get(remembered)
        completed.delete(remembered)
        if (rememberedId && table.citesAbandoned(rememberedId)) table.releaseKey(rememberedId)
      }
      attempt.length = mark
      selfReferential.add(type)
    } finally {
      walking.delete(type)
      if (outermost) journal = null
    }
    // Retry inside the alias-recurrence frame that owns this walk. Calling
    // `typeOf` here would enter `aliasRecurrence.within` again before the
    // outer frame's `finally` has popped the same alias. The recurrence guard
    // would then find an ancestor whose failed walk has stopped walking but
    // whose retry has not reserved its anchor yet, and publish an unresolved
    // carrier instead of taking the self-referential branch above.
    //
    // The retry itself must bypass only that already-active outer guard. Every
    // nested type reached while rebuilding still enters through `typeOf`, so
    // equivalent back edges fold to the new `inProgress` anchor and a changed
    // alias instantiation continues to refuse fail-closed.
    return typeOfWalk(type)
  }

  /**
   * A type reference's OWN type arguments.
   *
   * `checker.getTypeArguments` answers with the reference's full argument list,
   * and for a target that declares a `this` type -- which every class and every
   * interface reached through one does -- that list carries one MORE entry than
   * the declaration has parameters: a trailing slot holding the reference's
   * `this` type, threaded through as an argument that no source ever writes.
   *
   * `super.has(name)` inside `class CaseInsensitiveMap<K extends string>
   * extends Map<K, string>` is the case that exposed it. The `Map` reference
   * answers THREE arguments -- `K`, `string`, `this` -- and
   * `representation/collections.ts`'s arity guard then refused, correctly, a
   * `map` that "needs exactly 2". The guard was right and the count was wrong.
   *
   * The declaration's own parameter list is the authority on how many arguments
   * a reference to it has, so the answer is cut to it. Cutting rather than
   * asserting: a target with no `typeParameters` at all (a tuple reached
   * through this path, an anonymous reference) is left exactly as the checker
   * answered.
   */
  const typeArgumentsOf = (type: ts.Type): readonly ts.Type[] => {
    const reference = type as ts.TypeReference
    const args = checker.getTypeArguments(reference) ?? []
    const declared = reference.target?.typeParameters?.length
    return declared !== undefined && args.length > declared ? args.slice(0, declared) : args
  }

  /**
   * Whether an alias symbol IS one of the standard library's own type-level
   * operators, by name -- `null` in a program whose lib does not declare it.
   *
   * Resolved lazily and once per name, in the scope of the alias declaration
   * being asked about, exactly the way `host-protocols.ts`'s
   * `promiseDeclarationOf` resolves `Promise`: the question is "does this
   * alias mean the language's own operator", and `checker.resolveName` is the
   * public API that answers it without a use site. Resolving by name rather
   * than trusting the spelling is the whole point -- a program's own
   * `type Awaited<T> = ...` is a different operator with the same name.
   */
  const globalAliases = new Map<string, ts.Symbol | null>()
  const isGlobalAlias = (name: string, symbol: ts.Symbol, at: ts.Node): boolean => {
    if (!globalAliases.has(name)) globalAliases.set(name, checker.resolveName(name, at, ts.SymbolFlags.TypeAlias, false) ?? null)
    const resolved = globalAliases.get(name) ?? null
    return resolved !== null && resolved === symbol
  }

  /**
   * The one type-level operator argument, if this type is one of the two the
   * checker can still evaluate, and its own single argument.
   */
  const operatorArgument = (type: ts.Type, name: string): ts.Type | null => {
    const alias = type.aliasSymbol
    const argument = type.aliasTypeArguments?.[0]
    if (!alias || !argument || type.aliasTypeArguments?.length !== 1) return null
    const at = alias.declarations?.[0]
    return at && isGlobalAlias(name, alias, at) ? argument : null
  }

  /**
   * This copy's filling for a type, closed as far as anything here can close it.
   *
   * Three ways, tried in order, and the third is what makes the operators
   * below compose. The image is the checker's own instantiation of a copy's
   * member type (`structural-instantiated-member.ts`); the path substitution
   * answers for a bare parameter a copy binds; and the recursion answers for a
   * parameter wrapped in one of the operators -- `NonNullable<TSchema>` closes
   * because `TSchema` does.
   */
  const closedForm = (type: ts.Type): ts.Type | null => {
    const image = instantiatedMembers.through(type)
    if (image) return image
    const substituted = substituteTypeParameter(type)
    if (substituted !== type) return substituted
    return reducedOperator(type)
  }

  /**
   * A DEFERRED `Awaited<T>` or `NonNullable<T>`, re-asked of the checker with
   * this copy's own filling in place of the hole.
   *
   * `await fn()` inside `withRespawn<T>(fn: () => Promise<T>)` types as
   * `Awaited<T>`. The checker cannot reduce `T extends PromiseLike<infer U>`
   * while `T` is open, so it keeps the conditional unreduced -- and a
   * conditional type names no structure, so everything downstream of it
   * refused: the await's own result, the `const` it initializes, the `return`
   * that publishes it. mongodb's driver is generic almost everywhere and this
   * was its single largest root, 616 of its mandatory obligations.
   *
   * Monomorphization has already closed the hole this walk is inside, so the
   * reduction is not deferred any more -- only the checker's ability to spell
   * it as a type is. `getAwaitedType` and `getNonNullableType` are the
   * checker's OWN implementations of the two operators, so handing one the
   * closed argument asks precisely the question that was deferred, rather than
   * re-deriving an answer beside the language's. Nothing is reduced when the
   * argument is still open, and an answer that comes back conditional again is
   * discarded: both leave the shape exactly as it was.
   *
   * These are the ONLY two this layer reduces, and the reason is the same for
   * both: the checker exposes the operator. `resolvedTrueType`/
   * `resolvedFalseType` on a deferred `ts.ConditionalType` are lazily populated
   * and read `undefined` from outside the checker, so a general "pick the
   * branch the closed check type satisfies" rule has no branches to pick --
   * measured, not assumed. `T[number]` is refused here for the mirror-image
   * reason: `getIndexedAccessType` is not on the public checker at all.
   *
   * `NonNullable` is NOT gated on `TypeFlags.Conditional`, and that is not an
   * oversight: since TypeScript 4.8 it is spelled `T & {}`, so a deferred one
   * arrives as an INTERSECTION. mongodb's `abstract_cursor.ts` is the case --
   * `transformDocument(document: NonNullable<TSchema>): Promise<NonNullable<TSchema>>`,
   * awaited at four sites in six copies -- and gating on the flag is what left
   * it unreduced while the bare `Awaited<TSchema>` beside it reduced fine.
   */
  const reducedOperator = (type: ts.Type): ts.Type | null => {
    const awaited = operatorArgument(type, 'Awaited')
    if (awaited) {
      const closed = closedForm(awaited)
      const reduced = closed ? checker.getAwaitedType(closed) : null
      return reduced && (reduced.flags & ts.TypeFlags.Conditional) === 0 ? reduced : null
    }
    const nullable = operatorArgument(type, 'NonNullable')
    if (nullable) {
      const closed = closedForm(nullable)
      const reduced = closed ? checker.getNonNullableType(closed) : null
      return reduced && (reduced.flags & ts.TypeFlags.Conditional) === 0 ? reduced : null
    }
    return null
  }

  function translate(type: ts.Type): StructuralTypeId {
    // Asked BEFORE anything else, because it answers about the very type that
    // was handed in rather than about its parts: an open member type of a
    // monomorphized copy has an instantiated image, and every question below --
    // is it a conditional, a union, a record -- has a different answer for the
    // image than for the hole. See `structural-instantiated-member.ts`.
    const instantiated = instantiatedMembers.through(type)
    if (instantiated) return remember(type, typeOf(instantiated))
    // ⛔ BEFORE the conditional refusal below, not after it. A deferred
    // `Awaited<T>` IS a `ts.TypeFlags.Conditional` -- that is what the two
    // operators are spelled as -- so refusing every conditional first made
    // this line unreachable for the exact shape it exists to answer, and the
    // `getAwaitedType` reduction below it only ever ran for a `NonNullable`,
    // which since TypeScript 4.8 arrives as an INTERSECTION instead.
    //
    // `@hono/node-server`'s `readBodyWithFastPath<T>` is the case:
    // `Promise.resolve(fromBuffer(raw, request))` over a
    // `(buf, request) => T | Promise<T>` types as
    // `Promise<Awaited<T | Promise<T>>>`, and the copy that closed `T` got the
    // refusal rather than the reduction -- 54 of hono-hello's 225 roots, every
    // one of them a `promise(unresolved)` obligation off those two lines.
    //
    // Safe ahead of the refusal because this reads only `aliasSymbol` and
    // `aliasTypeArguments`, two plain fields on the type object, and calls the
    // checker only with an argument monomorphization has already CLOSED. What
    // the refusal is positioned to come before is declared-alias
    // NORMALIZATION further down, which asks a recursive conditional alias to
    // instantiate the very form it deferred -- hono's fluent environment
    // accumulator (`IfAnyThenEmptyObject<...>`, one alias deeper per route)
    // exhausted TypeScript's stack there. That alias is neither `Awaited` nor
    // `NonNullable`, so `operatorArgument` rejects it on the name and this
    // line returns before any checker call.
    const awaited = reducedOperator(type)
    if (awaited) return remember(type, typeOf(awaited))
    // A conditional that still exists after this copy's instantiated-member
    // image was asked for, and that neither operator above could reduce, is
    // unresolved.
    if (type.flags & ts.TypeFlags.Conditional)
      return remember(
        type,
        unresolved(
          'an anonymous conditional type is still gated on a type parameter; monomorphization never filled it',
          'erased-type-expression'
        )
      )
    const primitive = primitiveFor(type)
    if (primitive) return remember(type, table.intern(primitive))
    const literal = literalFor(type)
    if (literal) return remember(type, table.intern(literal))
    const bag = bagShapeOfType(typeOf, bags, type)
    if (bag) return remember(type, table.intern(bag))

    // The global `Object` INTERFACE is a top type, and its layout is a
    // fiction.
    //
    // `Object` declares only what every value already has -- `toString`,
    // `valueOf`, `hasOwnProperty` -- and every non-nullish value in the
    // language is assignable to it, so it states nothing about what a
    // particular cell holds. `derived-expression-type.ts`'s
    // `annotationStatesNothing` has said exactly that for a long time, and
    // three's `@type {Object}` / `@return {Object}` tags reach this very
    // interface -- but only the write-discovery CENSUSES consulted it, so
    // this layer went on interning `Object` as a `declared` shape with a
    // real body, and `representation/derive.ts` went on turning that body
    // into a `native-record-ref` naming a struct of prototype methods. Two
    // authorities, one saying "states nothing" and the other emitting a
    // layout for it.
    //
    // Nothing can be stored in that struct. On the three.js app it was the target
    // of 11 of the 29 unmet conversion obligations whose pair simply has no
    // node -- `boolean`, an `HTMLElement` handle, an object literal and an
    // array of class instances all flowing into a cell typed `?Object` --
    // and no conversion could exist for any of them, because the target
    // layout was never real.
    //
    // `any` is the honest carrier, and it is the box: a genuinely dynamic
    // boundary, which is what `Object` is. The `ObjectConstructor` interface
    // -- the type of the global `Object` VALUE -- is excluded by
    // `isGlobalObjectInterface`'s own construct-signature test, so
    // `Object.keys` and friends keep their real callable shape.
    //
    // Anchored on the type's own declaration purely because `resolveName`
    // needs some node to resolve a GLOBAL from; which node it is cannot
    // change the answer, and a user interface declaring the same members
    // still fails the declaration-identity test.
    const objectAnchor = type.getSymbol()?.declarations?.[0]
    if (objectAnchor && isGlobalObjectInterface(checker, objectAnchor, type)) {
      return remember(type, table.intern({ kind: 'primitive', primitive: 'any' }))
    }
    // `IArguments` is the checker's name for the `arguments` object, and the
    // `arguments` object IS the phantom rest array this compiler mints for a
    // body that reads it (`producers/bindings.ts`'s `argumentsObjectValueAt`
    // binds the reference to that array). A function returning `arguments`
    // therefore returns that array, and typing the result by the interface's
    // declared layout (a record with `length` and `callee`) put a second
    // authority over one value: the body's return carrier said array-object,
    // the signature's result said native-record-ref, and the return
    // conversion between them cannot exist.
    if (objectAnchor && isStandardInterfaceType(checker, objectAnchor, 'IArguments', type)) {
      return remember(
        type,
        table.intern({ kind: 'array', element: table.intern({ kind: 'primitive', primitive: 'any' }), readonly: false, extension: [] })
      )
    }

    if (type.flags & ts.TypeFlags.UniqueESSymbol) {
      const symbol = type.getSymbol()
      const declaration = symbol ? identities.declarationOfSymbol(symbol) : null
      return remember(
        type,
        declaration
          ? table.intern({ kind: 'unique-symbol', declaration: identities.declarationIdOf(declaration) })
          : unresolved('unique symbol without a declaration anchor')
      )
    }

    // `TypeParameter` extends `Type` with no extra members, so the predicate
    // `this is TypeParameter` narrows the *false* branch to `never` and hides
    // every later check. The flag carries the same fact without that collapse.
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const symbol = type.getSymbol()
      const declaration = symbol ? identities.declarationOfSymbol(symbol) : null
      // The polymorphic `this` type is a type parameter whose symbol is the
      // *class*, not a `TypeParameterDeclaration`. It is not a parameter a
      // caller instantiates: every value it can hold is an instance of that
      // class, so the class instance shape is its exact answer rather than an
      // erasure to a constraint. Treating it as an uninstantiated parameter is
      // what made every unannotated `this.field` read reach representation with
      // no carrier at all.
      //
      // JavaScript declares the same thing without the `class` keyword.
      // `function Renderer(gl) { this.setMode = setMode }`, called with `new`,
      // is a constructor function: the binder marks its symbol
      // `SymbolFlags.Class` alongside `Function`, `getDeclaredTypeOfSymbol`
      // answers with the inferred instance type exactly as it does for a
      // class -- and its declaration is a `FunctionDeclaration`, so
      // `isClassLike` alone said no. three.js's WebGL internals are written
      // this way throughout, and every `this.` inside one reached
      // representation as an uninstantiated parameter: 151 of the three.js app's root
      // diagnostics. The flag is checked rather than the syntax because the
      // syntax is the only thing that differs.
      if (symbol && declaration && (ts.isClassLike(declaration) || (symbol.flags & ts.SymbolFlags.Class) !== 0)) {
        // Routed through the class's own declared type rather than interned
        // here, so the anchor that makes recursive member walks terminate is the
        // one shared with every other mention of the class. Interning a second
        // shape under the same nominal key would race that anchor's completion.
        return remember(type, typeOf(checker.getDeclaredTypeOfSymbol(symbol)))
      }
      if (!declaration) return remember(type, unresolved('type parameter without a declaration anchor'))
      // What the copy this body belongs to binds the parameter to. This is the
      // monomorphization: `identity<T>` compiled inside copy 0 has `T` as
      // `number` and inside copy 1 as `string`, and both are exact rather than
      // an approximation, because each copy really is a separate function in
      // the language.
      //
      // The program-wide census answers the remaining case: a parameter bound
      // once everywhere, whose owner the census did not copy -- an ambient
      // declaration has no body to duplicate, so there is no copy for the path
      // to name and the unique binding is the whole answer.
      //
      // The substitution happens here, at the one place a type parameter is
      // turned into a shape, rather than in the deriver. A shape is what every
      // later stage keys on -- carriers, conventions, layouts -- so a parameter
      // substituted downstream would leave the graph citing one shape and the
      // representation another, which is the two-authorities defect this
      // architecture exists to avoid.
      const bound = boundByPath(declaration) ?? censusBindingOf(declaration)
      if (bound && bound !== type) return remember(type, typeOf(bound))
      // A parameter nothing bound, but that the author gave a DEFAULT, is not
      // an uninstantiated parameter: the language substitutes the default for
      // every reference that omits the argument, so `class App extends
      // Component` really is `Component<GeaElement>` and the checker has
      // already typed it that way. Reading it here keeps the shape and the
      // checker in agreement -- without it the un-monomorphized copy of the
      // base carried a naked parameter into its own field layout, which the
      // deriver correctly refused ("field \"el\" carries unresolved(type
      // parameter ... reached representation without monomorphization)") and
      // which cost `ttf-bench` its whole emission.
      //
      // After the two bindings above on purpose: a copy that really did
      // substitute something must keep what it substituted, and the default is
      // only the answer when nothing did.
      //
      // Measured cost, stated rather than hidden: three programs that import
      // `three` gain ~3,400 boxed carriers, because `lib.dom`'s `E = Element`
      // and `lib.es5`'s `TArrayBuffer = ArrayBuffer` resolve to types no host
      // table claims a carrier for. None of the three compiles either way, and
      // before this they were the same values counted as missing primitives
      // rather than as boxes -- neither state is native, and the cure for both
      // is a carrier for `Element`, not a naked type parameter. Excluding
      // defaults of `any` was tried and measured: it moved the number by 32.
      //
      // The default is asked of THIS parameter, not re-typed from its
      // declaration node. A method's default can name the enclosing
      // interface's parameter -- `Promise<T>.then<TResult1 = T, ...>` -- and
      // reading the node `= T` in the declaration's own scope hands back
      // `Promise`'s open `T` even when the receiver was `Promise<Response>`
      // and the checker had already instantiated the default to `Response`.
      // That open `T` reached representation through a promise method read as
      // a VALUE with no call to bind it -- `@hono/node-server`'s `isPromise`
      // (`typeof (res as Promise<Response>).then === 'function'`) -- and the
      // function-value carrier `(...)->promise(unresolved)` had no emitter
      // recipe. `getDefaultFromTypeParameter` returns the instantiated default
      // where one exists and the declaration's own where it does not, so the
      // measured cases above are unchanged.
      if (ts.isTypeParameterDeclaration(declaration) && declaration.default) {
        const instantiated = checker.getDefaultFromTypeParameter(type) ?? checker.getTypeFromTypeNode(declaration.default)
        return remember(type, typeOf(instantiated))
      }
      // A parameter a CALLABLE owns, reached where no copy binds it, is that
      // callable used as a VALUE: a generic arrow handed to `memoizeOne`, a
      // generic function passed where the parameter's type is itself generic
      // (`emitNodeList(emit, ...)` over `EmitFunction = <T extends Node>(node:
      // T, ...) => void`), or the result the checker propagated such an
      // argument's parameters into. One closure exists at runtime for all of
      // those, so its type parameters have exactly one filling, the
      // constraint -- the same one `specialization.ts`'s `constraintBindingsOf`
      // mints its copy over, and the one the checker itself lands on when a
      // call through the value cannot infer the parameter. A class, interface
      // or alias parameter is not answered this way: those are copied per
      // instantiation and never reached unbound by a body this compiles.
      if (ts.isTypeParameterDeclaration(declaration) && ts.isFunctionLike(declaration.parent)) {
        const constraint = checker.getBaseConstraintOfType(type) ?? checker.getUnknownType()
        if (constraint !== type) return remember(type, typeOf(constraint))
      }
      // A parameter an interface of a FAMILY owns (`Token<TKind extends
      // SyntaxKind>`), reached while the family's one layout is built from
      // the open declaration: the layout's field is the union over every
      // instantiation the program will ever make, and the constraint is that
      // union's upper bound -- `kind: SyntaxKind`, which is what every
      // `Token<SyntaxKind.X>` view reads it back through anyway. The census
      // admits only a constrained parameter, so `unknown` is never the answer.
      if (ts.isTypeParameterDeclaration(declaration) && ts.isInterfaceDeclaration(declaration.parent)) {
        const ownerSymbol = checker.getSymbolAtLocation(declaration.parent.name)
        const owner = ownerSymbol ? identities.declarationOfSymbol(ownerSymbol) : null
        if (owner && families.familyOf(identities.declarationIdOf(owner, rootSpecialization))) {
          const constraint = checker.getBaseConstraintOfType(type) ?? checker.getUnknownType()
          if (constraint !== type) return remember(type, typeOf(constraint))
        }
      }
      return remember(type, table.intern({ kind: 'type-parameter', declaration: identities.declarationIdOf(declaration) }))
    }

    // `keyof T`. `isIndexType` is the public narrowing predicate for the flag,
    // matching the `isUnion`/`isTupleType` style already used below rather
    // than reading `.type` off the bare `Type` interface.
    if (type.isIndexType()) {
      const baseId = typeOf(type.type)
      let outcome: KeyofOutcome
      try {
        outcome = keyofOfShapeId(baseId)
      } catch {
        // The base is a nominal type whose own body is still being built --
        // `keyof` reaching back into a declaration it is itself a member of.
        // The sealed-table read a moment from completing cannot answer that
        // yet, and reading around it with a second pass would race the
        // anchor this same walk is in the middle of completing, so this
        // states the gap instead of throwing out of `typeOf` entirely.
        outcome = { kind: 'unmodelled', reason: `keyof of ${baseId}, whose declaration has not finished normalizing, is not modelled` }
      }
      return remember(type, outcome.kind === 'resolved' ? outcome.id : unresolved(outcome.reason))
    }

    // `T[K]`. The checker resolves every concrete indexed access before this
    // layer sees it, so one reaching here is the generic form -- and the
    // substitution this copy performs is what makes it concrete.
    // `structural-indexed-access.ts` states the rest.
    if ((type.flags & ts.TypeFlags.IndexedAccess) !== 0) {
      const access = type as ts.IndexedAccessType
      const objectType = resolvedObjectType(access.objectType)
      const indexType = resolvedIndexType(access.indexType)
      // `any[K]` is `any` and `unknown[K]` is an error the checker already
      // reported -- neither is a member set to enumerate, and refusing it
      // reports a gap where the program declared one. hono's `Handler<E = any>`
      // binds `E` to `any` in one of `Context`'s copies, so `E['Bindings']`
      // there is the top type by the language's own rule, not a hole this
      // layer failed to fill. Answering with the object type itself adds no
      // dynamism: it IS the declared-any the program already carries.
      if ((objectType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return remember(type, typeOf(objectType))
      const substituted =
        objectType === access.objectType && indexType === access.indexType ? null : indexedAccessMemberTypes(checker, objectType, indexType)
      // The bound of the type the PROGRAM WROTE is asked before the bound of
      // what this copy substituted into it, and the two disagree in hono's
      // favour of the first. `Context<E extends Env>`'s `env: E['Bindings']`
      // has `Env`'s own `Bindings?: Record<string, unknown>` as its bound
      // answer -- a dictionary that may be absent, which is what the
      // declaration says. The substituted intersection's bound is `{}`, which
      // declares no `Bindings` at all and so answers `undefined` -- and a
      // cell of `undefined` cannot hold that member's own `= {}` initializer.
      // Both are upper bounds; the tighter one is not always the truer one,
      // and the one the author stated outranks the one a copy produced.
      // A substitution that answers pure ABSENCE steps aside for the bound, and
      // hono's `env: E['Bindings'] = {}` is why. The copy that binds `E` to
      // `BlankEnv` (`{}`) really does have no `Bindings` member, so absence is
      // the language's own answer for a READ there -- but the field's STORAGE
      // was sized by the declaration, which TypeScript checked against `E`'s
      // constraint `Env`, where `Bindings?: Record<string, unknown>`. That is
      // how `= {}` on the same line is legal at all. A copy cannot shrink a
      // cell below what the declaration it copies admits, so the constraint's
      // answer outranks the copy's here, and absence survives only when no
      // bound has anything better to say.
      const statesOnlyAbsence = substituted !== null && substituted.every((member) => (member.flags & ts.TypeFlags.Undefined) !== 0)
      const members =
        (statesOnlyAbsence ? null : substituted) ??
        memberTypesThroughBound(access.objectType, indexType) ??
        memberTypesThroughBound(objectType, indexType) ??
        substituted
      const only = members?.length === 1 ? members[0] : undefined
      if (only) return remember(type, typeOf(only))
      if (members) return remember(type, table.intern({ kind: 'union', members: members.map(typeOf) }))
      return remember(
        type,
        unresolved('an indexed access whose object type is still a type parameter has no member set to resolve', 'erased-type-expression')
      )
    }

    if (type.isUnion()) {
      // A member whose bound type substitutes to `unknown`/`any` in this
      // copy absorbs the whole union -- `Component<RootElement = unknown>`'s
      // own `readonly el: RootElement | null` must collapse to bare
      // `unknown` for the exact same reason `unknown | null` written
      // directly, with no generic involved, is never a two-member union to
      // begin with: the checker's own union construction already performs
      // this simplification (`getUnionType` is not on the public
      // `ts.TypeChecker` surface, so it is replicated here rather than
      // called). Only the top type absorbs this way -- `never` is the
      // bottom type and a `T | never` union does not collapse the same
      // direction, so it is deliberately not handled here.
      const absorbing = type.types
        .map(substituteTypeParameter)
        .find((candidate) => candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      if (absorbing) return remember(type, typeOf(absorbing))
      // An arm naming a type the host says is ABSENT is not an arm this
      // program can ever take. `absentGlobals` already folds the VALUE
      // (`typeof HTMLImageElement !== 'undefined'` is `false` on a headless
      // ANGLE host, `absent-globals.ts`); this is the same fact asked of the
      // TYPE, so a union declared `HTMLImageElement | HTMLCanvasElement |
      // ImageData` collapses rather than demanding a carrier for a DOM class
      // that cannot exist here. Substituting per MEMBER rather than over the
      // whole union is what lets a mixed union keep the arms that are real.
      // `never[]` is what an EMPTY ARRAY LITERAL with no contextual type
      // checks as, and it is assignable to every array type -- so beside
      // another array-like arm it names no value the union does not already
      // hold, and no second carrier. `(path.match(/.../g) || [])` (hono's
      // pattern router) is the shape: `RegExpMatchArray | never[]`, which
      // carried as a tagged union of a match result and an EMPTY STRUCT, and
      // an `Array.prototype` method on that has no static receiver at all --
      // the read fell back to boxing the arm and asking a dynamic
      // `getProperty("map")` that nothing answers.
      //
      // Dropped only when the union keeps an arm that is itself indexable by
      // number, so a `never[]` standing alone (or beside non-array arms) is
      // untouched: this removes a REDUNDANT arm, it does not decide that an
      // empty array is some other type.
      const numericElementOf = (arm: ts.Type): ts.Type | undefined => checker.getIndexTypeOfType(arm, ts.IndexKind.Number)
      // Contentless means EMPTY, not merely tuple-shaped: a tuple's numeric
      // index type is the union of its own elements, so a `[T, Params]` arm
      // answers a real element type and is a distinct shape this must not
      // touch (`Result<T>`'s two arms in hono's own router are a 1-tuple and a
      // 2-tuple). The two contentless spellings are `never[]` and the
      // zero-length tuple `[]`, which is what `x.match(re) || []` derives:
      // 13.2.4.2 gives an ArrayLiteral with no elements an Array of length 0,
      // and a value with no element cannot disagree with any element type, so
      // it is already a value of the arm beside it.
      const isEmptyArrayArm = (arm: ts.Type): boolean => {
        // `isArrayType` answers only for `Array<T>` -- a tuple is an array-LIKE
        // whose target is its own synthetic type -- so the tuple is asked first.
        if (checker.isTupleType(arm)) {
          const shape = (arm as ts.TupleTypeReference).target
          return shape.fixedLength === 0 && shape.elementFlags.length === 0
        }
        if (!checker.isArrayType(arm)) return false
        const element = checker.getTypeArguments(arm as ts.TypeReference)[0]
        return element !== undefined && (element.flags & ts.TypeFlags.Never) !== 0
      }
      const withoutEmptyArrays = type.types.filter((arm) => !isEmptyArrayArm(arm))
      const arms =
        withoutEmptyArrays.length === type.types.length ||
        withoutEmptyArrays.length === 0 ||
        !withoutEmptyArrays.some((arm) => numericElementOf(arm) !== undefined)
          ? type.types
          : withoutEmptyArrays
      const sole = arms.length === 1 ? arms[0] : undefined
      if (sole) return remember(type, typeOf(absent.substituteAbsentType(sole)))
      const present = arms.map((member) => absent.substituteAbsentType(member))
      // A union of pure INDEX-SIGNATURE objects is one table whose values are
      // the union. `Record<string, string> | Record<string, string[]>` (hono's
      // `_getQueryParam`, `utils/url.ts:255`) describes one object either way:
      // the arms differ in what an entry HOLDS, never in how entries are
      // stored, so the physical answer is a single `gea::Dictionary` over the
      // union of the value types. A tagged union of two dictionaries is the
      // wrong shape for it, and provably so: `results[name] = []` writes an
      // array through a carrier whose tag says the entries are strings, which
      // no per-arm dispatch can make correct -- there is one object and its
      // tag was fixed when `{}` was allocated.
      const table_ = joinedIndexUnionOf(checker, table, typeOf, present)
      return remember(type, table_ ?? table.intern({ kind: 'union', members: present.map(typeOf) }))
    }
    if (type.isIntersection()) {
      // The alias's own anchor, recorded beside the members rather than instead
      // of them: a branded alias (`type Rgb565 = number & { readonly
      // __geaRgb565: unique symbol }`) erases to its substantive member, and
      // the name is the only thing left that says which host type it is. This
      // still interns and derives as an intersection -- `derive.ts` reads the
      // anchor only where an installed host states a carrier for it.
      const anchor = declaredAnchorOf(type)
      const declaration = anchor?.kind === 'declared' ? anchor.declaration : null
      // A type guard's `Member & { field: Narrower }` is the family object
      // itself -- see `familyMemberNarrowedBy`. Asked before the members are
      // interned: the narrowing's own object literal would otherwise be laid
      // out as a record nothing converts the family reference into. Asked
      // for a NAMED intersection too (`type LiteralImportTypeNode =
      // ImportTypeNode & { readonly argument: LiteralTypeNode & { ... } }`):
      // the alias names a view, and the anchor a branded alias keeps below
      // never applies -- a family member is never a brand's substantive half.
      const narrowedMember = familyMemberNarrowedBy(type)
      if (narrowedMember !== null) return remember(type, narrowedMember)
      const members = type.types.map(typeOf)
      const joined = declaration === null ? joinedCallableOf(table, type, members) : null
      if (joined) return remember(type, joined)
      const distributed = declaration === null ? distributedIntersectionOf(members) : null
      if (distributed !== null) return remember(type, distributed)
      // The checker's own reconciliation of the members, interned beside them.
      // See the `resolved` field's doc comment (`model/structural-types.ts`):
      // reading `A & B`'s members off the intersection TYPE is asking the one
      // authority that owns the reduction, instead of merging carriers pairwise
      // a layer later.
      // A deferred member means the checker has not reconciled this
      // intersection. Asking for its synthesized properties forces the
      // checker to instantiate the deferred conditional recursively and also
      // gives each equivalent unfolding a fresh resolved shape. Keep the
      // explicit members as the fail-closed answer until monomorphization has
      // supplied an instantiated image. This lets recursive generic APIs fold
      // on their physical member layout instead of expanding type-only fluent
      // history indefinitely.
      const resolved = carriesDeferredForm(type) ? null : table.intern(objectShapeOf(type, null, 'interface'))
      return remember(type, table.intern({ kind: 'intersection', members, declaration, resolved }))
    }

    const indexed = indexedShapeOf(type)
    if (indexed) return remember(type, table.intern(indexed))

    const declared = declaredAnchorOf(type)
    if (declared) {
      // Anchor before walking members. Every cycle in the type graph passes
      // through a declared name, so this is the one place that makes recursion
      // terminate: a member that refers back resolves to an id that already
      // exists instead of re-entering translation.
      // The key uses the arguments' canonical structural ids, not the checker's
      // type objects: the checker hands back a fresh object for each mention of
      // one instantiation, so object identity would mint a new anchor per member
      // and the member walk below would never converge.
      //
      // A class or interface's own type parameter that never reaches a stored
      // field -- `layoutRelevantParameterIndices`'s own question -- is folded
      // to one canonical placeholder instead of its real argument. Two
      // instantiations that disagree ONLY on such a parameter (hono's
      // `Hono<E,S,BasePath,CurrentPath>` across every distinct route
      // registration, `S` never stored) are the SAME physical layout, and
      // keying them apart mints one specialization per call site -- the
      // shape of the `#addRoute` producer stack overflow this exists to cut
      // off. `Context<E,...>`'s `env: E['Bindings']` keeps `E` unerased: an
      // unproven position is never folded, only one the field walk actually
      // proved irrelevant.
      const genericOwner =
        ts.isClassLike(declared.declarationNode) || ts.isInterfaceDeclaration(declared.declarationNode) ? declared.declarationNode : null
      const layoutRelevant = genericOwner ? layoutRelevantParameterIndices(checker, genericOwner) : null
      //
      // A class's CONSTRUCTOR type (`typeof Box`) carries no type arguments,
      // so the constructor side of a generic class was one anchor for every
      // instantiation -- one construct signature, one instance carrier and
      // one thunk, whichever copy completed it first, and `new Box<string>`
      // beside `new Box<number>` converted its argument to the other copy's
      // parameter. Inside a copy of the class, when the class's copies can
      // differ in layout at all (`copiesMayDifferInLayout`), the copy's own
      // fillings are the arguments the constructor object is being read AT
      // (`this.constructor`, `new Box(...)` in a method, and every
      // `new Box<string>(...)` site, which the census types in the copy it
      // reaches), folded exactly as the instance side folds its written
      // arguments; the deriver's `physicalClassDeclarationOf` then keys the
      // two sides of one instantiation to one physical class. Outside any
      // copy the arguments stay empty, which is the root's own constructor
      // object.
      const copy =
        declared.kind === 'class-constructor' &&
        ts.isClassLike(declared.declarationNode) &&
        specializations.copiesMayDifferInLayout(declared.declarationNode)
          ? foldedCopyOf(declared.declarationNode, layoutRelevant)
          : null
      // A class whose copies must not split has ONE struct. Keying each
      // instantiation's anchor on its own written fillings gives that one
      // struct several shapes, and its field carriers then come from
      // whichever shape completed the anchor first -- for
      // `ReadableStream<any>` beside `ReadableStream<Uint8Array>` that was
      // the `any` one, so the struct stored `dynamic` and every read in the
      // concrete copy refused a narrowing no target installs. The census
      // names the most specific copy instead; keying every instantiation
      // there gives the collapse a single honest shape, and the wider
      // copies' reads widen out of it.
      const canonical =
        declared.kind === 'class-instance' && genericOwner && ts.isClassLike(genericOwner)
          ? specializations.canonicalLayoutFillings(genericOwner)
          : null
      const typeArguments =
        declared.kind === 'class-constructor'
          ? (copy?.typeArguments ?? [])
          : typeArgumentsOf(type).map((argument, index) => {
              if (layoutRelevant && !layoutRelevant.has(index)) return erasedTypeArgument()
              return typeOf(canonical?.[index] ?? argument)
            })
      // Reserved before the body is built, because building it walks members and
      // a member can reach this same anchor through a second checker type
      // object. `fresh` says which of the two this call is: the reserver
      // completes, everyone else just reads the id back.
      const { id: anchor, fresh } = table.anchor(`${declared.kind}:${declared.declaration}:${typeArguments.join(',')}`)
      if (copy) recordClassCopy(declared.declaration, copy.ordinal, copy.typeArguments, anchor)
      inProgress.set(type, anchor)
      remember(type, anchor)
      let settled = false
      try {
        if (fresh) table.complete(anchor, buildDeclaredShape(type, declared, typeArguments))
        settled = true
      } finally {
        inProgress.delete(type)
        // An unwound walk leaves nothing standing: not the memo, and -- when
        // this walk is the one that reserved it -- not the reservation either.
        if (!settled) {
          completed.delete(type)
          if (fresh) table.abandon(anchor)
        }
      }
      return anchor
    }

    const callSignatures = type.getCallSignatures()
    const constructSignatures = type.getConstructSignatures()
    if (callSignatures.length > 0 || constructSignatures.length > 0) {
      // The type of an overloaded SOURCE function is every declared overload,
      // which is the checker's right answer for resolving a call and the
      // wrong one for the VALUE: the one function object that exists is the
      // implementation, and it declares exactly one signature.
      // `sharedAbiOf` (derive.ts) saw N conventions here and boxed every read
      // of `pad` -- and every unannotated `const padder = pad`, field and
      // parameter that shares the type object -- as
      // `dynamic(unjoinable-declared-overload-set)`, a typed function value
      // boxed. Inside a copy of a GENERIC implementation it was worse: the
      // overloads' own type parameters, which no copy ever binds, reached
      // representation as naked holes (TypeScript's `core.ts` `some`, `find`,
      // `every`, `filter`, `map`...). One answer at the one place the type
      // is interned, through this copy's own `signatureOf`, so the
      // implementation's `T` is substituted exactly as its body's would be.
      // `valueTypeAt` gives the DECLARATION the same answer.
      const implementation = sourceOverloadImplementationOf(callSignatures, constructSignatures)
      const generic = genericSourceFunctionOf(type, callSignatures, constructSignatures, implementation)
      return remember(
        type,
        table.intern({
          kind: 'signature',
          call: implementation ? [signatureOf(implementation)] : callSignatures.map((one) => signatureOf(one)),
          construct: constructSignatures.map((one) => signatureOf(one)),
          ...(generic ? { generic } : {})
        })
      )
    }

    if (type.flags & ts.TypeFlags.Object) {
      const symbol = type.getSymbol()
      const location = symbol ? identities.declarationOfSymbol(symbol) : null
      if (location) {
        // An object literal with at least one method whose OWN body reads
        // `this` can have that method's member signature read `this` back to
        // the literal itself (`{ imageId: 1, describe() { return
        // this.imageId } }`) -- `implicitReceiverOf` above now answers such a
        // method's receiver with `layoutTypeAt(parent)`, which is THIS type
        // (or the type it shares identity with via the contextual-type
        // preference). Interning the body plainly, as the pure-data branch
        // below does, would walk `describe`'s own signature *while this exact
        // walk is still running* and recurse forever -- there is no anchor
        // yet for the receiver to resolve to. So a self-referencing object
        // literal is anchored EAGERLY, before its members are walked, exactly
        // as `declaredAnchorOf`'s interface/class/type-alias branch above
        // already anchors before descending -- the one difference being the
        // anchor here is keyed by the literal's own declaration
        // (`ObjectLiteralExpression`) rather than by a named
        // interface/class/alias, since a bare literal has no such name.
        //
        // Scoped to a method whose body ACTUALLY reads `this` (not merely
        // "has a method", and not an accessor -- an accessor's member type in
        // the shape is the property type, not its own signature, so it never
        // re-enters through `objectShapeOf`'s member walk the way a method
        // does, exactly as `implicitReceiverOf` above reasons). Anchoring
        // every callable-bearing literal regardless of `this` usage was tried
        // first and cost 25/116 corpus programs their certification --
        // ordinary event-handler-shaped literals (`{ onClick() { ... } }`,
        // never reading `this`) do not need this identity change and paid for
        // it anyway, by widening which literals reach `implicitReceiverOf`'s
        // interface-signature branch downstream (removed in edit 4 -- see
        // that edit's discussion, "Cause 3" in `risks.md`). A pure-data
        // object literal, and a callable-bearing one whose methods never read
        // `this`, both keep interning straight into `objectShapeOf`,
        // completely unchanged, below.
        //
        // A `function` expression held by a PROPERTY (`{ m: function () {
        // return this } }`) is the same method spelled the ES5 way, and
        // `structural-receiver.ts`'s `jsConstructorReceiverOf` grants it the
        // same receiver behind the same body gate -- so it needs the same
        // anchor, or the receiver's self-reference has no nominal carrier.
        const hasSelfReferencingMethod = type.getProperties().some((property) => {
          const declaration = identities.declarationOfSymbol(property)
          if (declaration === null) return false
          if ((property.flags & ts.SymbolFlags.Method) !== 0) {
            return ts.isMethodDeclaration(declaration) && declaration.body !== undefined && bodyReadsThis(declaration.body)
          }
          return (
            ts.isPropertyAssignment(declaration) &&
            ts.isFunctionExpression(declaration.initializer) &&
            declaration.initializer.body !== undefined &&
            bodyReadsThis(declaration.initializer.body)
          )
        })
        if (!hasSelfReferencingMethod) {
          return remember(type, table.intern(objectShapeOf(type, location)))
        }
        const declarationKey = `object-literal:${identities.declarationIdOf(location)}`
        const { id: anchor, fresh } = table.anchor(declarationKey)
        inProgress.set(type, anchor)
        remember(type, anchor)
        let settled = false
        try {
          if (fresh) {
            const body = table.intern(objectShapeOf(type, location))
            table.complete(anchor, { kind: 'object-anchor', declaration: identities.declarationIdOf(location), body })
          }
          settled = true
        } finally {
          inProgress.delete(type)
          if (!settled) {
            completed.delete(type)
            if (fresh) table.abandon(anchor)
          }
        }
        return anchor
      }
      // The object itself has no declaring symbol to anchor a `location` on --
      // `typeof globalThis` is the standing example, a synthetic checker type
      // whose OWN symbol has zero declarations (verified directly against the
      // checker: `type.getSymbol()` answers a real symbol named `globalThis`,
      // but `getDeclarations()` on it is empty). Its members are not
      // similarly synthetic: each is an ordinary ambient binding with a real
      // declaration of its own, and `memberOf` already prefers a member's own
      // declaration over the `location` it is passed (`declaration ?? location`
      // above), so any member here resolves correctly without ever consulting
      // `location`. Borrowing one member's declaration as the fallback only
      // matters for a member that itself has none, which is exactly the case
      // this branch could not previously tell apart from "every member is
      // fine, only the container lacks a name" -- and that harder case still
      // refuses below, unchanged.
      //
      // `data-only` mode is not just `declaredBodyOf`'s existing "we do not
      // implement ambient methods" reason (structural.ts's `declaredBodyOf`,
      // a few lines below): for a declarationless object it is also what
      // keeps this walk finite. `typeof globalThis`'s own `globalThis`
      // property mentions the type again (`declare var globalThis: typeof
      // globalThis`) and there is no anchor reserved here to break that
      // cycle on, unlike the `declared`/`class-instance` branch above. But
      // `globalThis` is checker-flagged `Module`, not `Property` -- like
      // every other ambient `var`/`function` binding at global scope
      // (`Array`, `console`, `eval`, ...), which are *not*
      // `SymbolFlags.Property` even though they read as ordinary data from
      // JS. `data-only` mode (`isDataMember`, below) filters exactly these
      // out, so the self-reference is never visited and never has a chance
      // to recurse.
      // A checker type flagged `Object`, with no declaring symbol AND no
      // structural facet at all -- no property, no index signature (call and
      // construct signatures were already excluded by the check above) -- is
      // not a shape this program wrote and this walk failed to normalize. It
      // is TypeScript's own internal answer to "some value, narrowed only to
      // exclude `null`/`undefined`": what `unknown` (or an unconstrained
      // generic, or the `{}` top type) becomes after a truthy check with no
      // `typeof`/`instanceof` narrowing to say anything more. `typeToString`
      // prints it `{}`, which reads exactly like an empty object literal, but
      // it is not one: a real `{}` literal anchors on its own
      // `ObjectLiteralExpression` and is caught by the `location` branch
      // above, as a genuinely, physically empty record. This one has no
      // declaration anywhere to anchor on because nothing in the program
      // wrote it -- the checker synthesized it purely to narrow the runtime
      // set of possible values without exposing a name for it. Laying it out
      // as an empty C++ record would claim a shape the runtime value might
      // not physically have at all (only `null`/`undefined` are excluded; it
      // could still be a `number`, a `string`, a function, anything), so the
      // honest carrier is the one plain `unknown` already gets: `dynamic`,
      // not a refusal.
      if (type.getProperties().length === 0 && checker.getIndexInfosOfType(type).length === 0) {
        return remember(type, table.intern({ kind: 'primitive', primitive: 'unknown' }))
      }
      // A member's own declaration is what `memberOf` asks at; the borrowed
      // sibling declaration below only ever answered for a member that has
      // NONE, and it is `null` when no member has one. That used to be a
      // refusal, on the reasoning that a location had to come from somewhere --
      // but the location was never the question. `getTypeOfSymbol` asks a
      // declarationless symbol for its type directly (`structural-parts.ts`'s
      // `typeOfSymbolAt`), which is available here and strictly more truthful
      // than borrowing an unrelated member's node. Every member with a
      // declaration still resolves at its own, so nothing that already worked
      // moves; what this unblocks is three.js, whose JSDoc-typed objects reach
      // here with no member declaration anywhere (three.js app violations 157 -> 21).
      const anchorLocation =
        type
          .getProperties()
          .map((property) => identities.declarationOfSymbol(property))
          .find((declaration): declaration is ts.Declaration => declaration !== null) ?? null
      return remember(type, table.intern(objectShapeOf(type, anchorLocation, 'data-only')))
    }

    // The `object` keyword type -- "any value that is not a primitive" -- is
    // its own flag (`NonPrimitive`), not `TypeFlags.Object`: it is a pure
    // keyword with no declaring symbol, so `type.getSymbol()` above is always
    // `undefined` for it and the branch that needs one never applies. It also
    // has no properties, no call/construct signature, and no index signature
    // of its own to enumerate (verified against the checker directly), so an
    // object shape with an empty member list and no index is not a guess --
    // it is exactly what `getProperties()`/`getIndexInfosOfType()` already
    // report for it. That is the same physical SHAPE `{}` gets -- no members,
    // no index -- but NOT the same physical CARRIER, and the difference
    // matters. `representation/derive.ts` turns an empty object shape into a
    // `record` with zero fields, and `record`'s conversion-from-dynamic has no
    // installed materializer anywhere in this codebase
    // (`conversion/build.ts`'s `emptyConversionRegistry.recordMaterializer: ()
    // => null`, never overridden by the C++ backend). That gap is universal
    // across every record shape today, so this choice costs nothing YET -- but
    // it is a latent trap, not a safe default. Record structs are nominal and
    // per-shape (`targets/cpp/records.ts`'s `cppRecordStructName(shapeId)`, one
    // distinct C++ struct per shape, no shared base), so the day anyone
    // installs a record materializer, a dynamic value narrowing to `record` of
    // this empty shape will either fabricate a fresh, identity-unrelated empty
    // struct -- breaking anything that depended on WHICH object it was, a
    // WeakMap key or an `===` -- or be reinterpreted as a struct type it never
    // was. Measured on the three.js app: 56 obligations of exactly this form, every one
    // a key argument to a bare `new WeakMap()` in three's renderer, where TS's
    // own `K extends object = object` default filled in for inference it had
    // nothing to work from. The cure is upstream -- infer the collection's type
    // arguments from its uses -- NOT a carrier general enough to swallow the
    // question, which would box the renderer's hot path and hide the gap.
    if (type.flags & ts.TypeFlags.NonPrimitive)
      return remember(type, table.intern({ kind: 'object', members: [], index: [], membersDropped: false }))

    // A SUBSTITUTION type is its base type, with a narrower constraint the
    // checker remembers for inference -- nothing more.
    //
    // TypeScript mints one inside the TRUE branch of a conditional, where it
    // knows `T extends X` held: the type of a value there is still `T`, but
    // every inference made from it may assume `X`. So the two are mutually
    // assignable and `getReducedType` erases the wrapper; the base is the
    // answer, and taking the CONSTRAINT instead would name an upper bound the
    // value need not have.
    //
    // Not any of the flags the tests above match, so without this a
    // substitution falls through to the bare-flags refusal below. Measured
    // ZERO on the mongodb probe and kept for the reason the reduction itself
    // states: a form the language erases must not be a refusal, and the one
    // line costs nothing.
    if (type.flags & ts.TypeFlags.Substitution) return remember(type, typeOf((type as ts.SubstitutionType).baseType))

    // An ANONYMOUS deferred conditional -- `X extends Y ? A : B` written
    // inline, with no alias to name it.
    //
    // Named separately from the bare-flags refusal below because that refusal
    // reads as a gap in this switch and this is not one: it is the same wall
    // `structural-declared-body.ts` states for an ALIASED conditional, reached
    // by a type that has no alias symbol and so never becomes a `declared`
    // shape at all. There is nothing to reduce it with -- `resolvedTrueType`/
    // `resolvedFalseType` on a deferred conditional read `undefined` from
    // outside the checker, and `reducedOperator` above can only answer for the
    // two operators the checker exposes -- so the only routes out are the
    // instantiated image `translate` already consults first, or closing the
    // check type upstream. "checker type with flags 16777216" sent a reader
    // looking for a missing type FORM; the form is modelled, the reduction is
    // not.
    return remember(type, unresolved(`checker type with flags ${type.flags} is not modelled`))
  }

  const remember = (type: ts.Type, id: StructuralTypeId): StructuralTypeId => {
    completed.set(type, id)
    journal?.push(type) // so an unwind can take it back -- see `typeOf`'s retry
    return id
  }

  const layoutTypeAt = createLayoutTypeResolver(checker, parameters, absent)

  /**
   * The type at a node, with an absent host type collapsed -- and with that
   * collapse followed through a member read.
   *
   * `substituteAbsentType` answers about the type a node was declared with, so
   * it collapses the RECEIVER on its own: `canvas`, declared
   * `HTMLCanvasElement` by three.js's JSDoc, is `never` on a host with no DOM.
   * The member read is a different node, and the checker still answers it with
   * `HTMLCanvasElement.addEventListener`'s whole overload set -- so one
   * expression ends up carrying two incompatible facts: a receiver no value can
   * inhabit, and a member typed by the class that receiver cannot be. The
   * member is the half that has to give. Reading a property of a value that
   * cannot exist produces a value that cannot exist.
   *
   * This is not an optimization. `three-angle-metal`'s seven violations and
   * seven unresolved carriers were all this one shape -- `canvas.getContext`
   * (five overloads) and `canvas.addEventListener`/`removeEventListener` (two
   * each) -- refused as "no primitive joining N overload signatures into one
   * calling convention". That refusal was correct about the overloads and
   * wrong about the question: the overload set is a phantom. On this target
   * `canvas` is a native handle, and joining arms of a class that cannot exist
   * was never something the program asked for.
   *
   * It recurses through the receiver rather than reading `layoutTypeAt` there
   * directly, so a chain collapses from wherever the absent type actually is:
   * in `a.b.c` it is `a` that cannot exist, and `a.b` has to be `never` before
   * `a.b.c` can be.
   */
  const absentSubstitutedTypeAt = (node: ts.Node): ts.Type => {
    const own = absent.substituteAbsentType(layoutTypeAt(node))
    if ((own.flags & ts.TypeFlags.Never) !== 0) return own
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return own
    const receiver = absentSubstitutedTypeAt(node.expression)
    return (receiver.flags & ts.TypeFlags.Never) !== 0 ? receiver : own
  }

  /**
   * A value declared `any`/`unknown` and narrowed only to the bare `object`
   * type is still a dynamic boundary. `typeof value === 'object'` proves that
   * property operations are permitted; it does not discover a field layout
   * or turn the value into a closed empty record. Keeping the declaration's
   * carrier here lets `key in value` and later dynamic reads consult the real
   * runtime object instead of asking a zero-field C++ struct to answer them.
   * A stronger narrowing (an interface, class, array, or other named shape)
   * has ordinary Object flags rather than NonPrimitive and remains untouched.
   */
  const dynamicObjectBoundaryAt = (node: ts.Node): ts.Type | null => {
    if (!ts.isIdentifier(node)) return null
    if ((absentSubstitutedTypeAt(node).flags & ts.TypeFlags.NonPrimitive) === 0) return null
    const symbol = checker.getSymbolAtLocation(node)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (!symbol || !declaration) return null
    const declared = checker.getTypeOfSymbolAtLocation(symbol, declaration)
    return (declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ? declared : null
  }

  /**
   * A read the checker's control-flow analysis cannot place. An unannotated,
   * uninitialized `var t;` is auto-typed: the checker evolves the cell through
   * the assignments it can SEE, and a read that follows only the declaration
   * answers `undefined` -- the initial state -- even when a nested function
   * (`{ m: function () { t = this } }`, called before the read) has written the
   * cell in between, because the analysis never follows a call. The census read
   * every write through the flow index and bound the cell to what they store;
   * a bare-`undefined` read of such a cell tested nothing, so it is not a
   * narrowing the cell has to be converted for. The cell's own type is the
   * answer. A read the checker places from a write in the reader's OWN scope,
   * and a cell every write of which sits beside its reads, keep the checker's
   * view: there the `undefined` is the program's, not the analysis's.
   */
  const unplacedHoistedReadAt = (node: ts.Node): ts.Type | null => {
    if (!flow || !ts.isIdentifier(node)) return null
    const own = absentSubstitutedTypeAt(node)
    if ((own.flags & ts.TypeFlags.Undefined) === 0 || own.isUnion()) return null
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.type || declaration.initializer) return null
    if (node === declaration.name || !ts.isIdentifier(declaration.name)) return null
    const reader = ts.findAncestor(node, ts.isFunctionLike) ?? null
    const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
    if (!writes.length || !writes.some((write) => (ts.findAncestor(write.site, ts.isFunctionLike) ?? null) !== reader)) return null
    const cell = parameters.typeAt(declaration)
    return cell && (cell.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined)) === 0 ? cell : null
  }

  /**
   * Whether this node is the one its parent site NAMES, rather than merely a
   * child of it.
   *
   * A call is recorded as one instantiation site, and everything under it --
   * the callee, but also every ARGUMENT -- has that call as its parent. Only
   * the callee is typed by the copy the call reaches; an argument is typed by
   * the scope it is written in, which is the ENCLOSING copy, and reading it
   * through the callee's copy loses whatever that enclosing copy binds. In
   * `outer<T>(op: T) { inner(op) }` compiled as `outer<Heavy>`, `op` read
   * through `inner`'s copy is a naked `T` again -- the exact hole
   * monomorphization removes, put back one node to the right of where it was
   * removed.
   *
   * A type reference (`Foo<Bar>`) is recorded on the reference node itself and
   * names no separate callee, so it answers `true` and behaves as before.
   */
  const namesItsSite = (node: ts.Node): boolean => {
    const site = node.parent
    if (ts.isCallOrNewExpression(site)) return site.expression === node
    if (ts.isTaggedTemplateExpression(site)) return site.tag === node
    if (ts.isJsxOpeningLikeElement(site)) return site.tagName === node
    return true
  }

  /**
   * The type of the *value* a declaration introduces.
   *
   * `getTypeAtLocation` on a class declaration answers with the instance type,
   * because that is what the name means in a type position. The value the
   * declaration binds is the constructor object, which is the symbol's type --
   * a different type with different members, and asking the wrong one is how a
   * constructor ends up carried as one of its own instances.
   */

  const localUnionAt = createLocalUnionResolver(
    checker,
    table,
    parameters,
    flow,
    (node) => mapper.typeAt(node),
    (node) => (ts.isExpression(node) ? objectDescriptorReturnTypeAt(unwrapErasedExpression(node)) : null)
  )
  const callResultAt = createStructuralCallResultResolver(checker, table, (node) => mapper.typeAt(node))
  const constructResultAt = createStructuralConstructResultResolver(table, (node) => mapper.typeAt(node))
  const impliedPatternArrayLiteralType = (node: ts.ArrayLiteralExpression): StructuralTypeId | null => {
    // A tuple, or the empty literal the checker types `never[]` against a
    // rest pattern's `any[]` silhouette (`f([])` for `function f([...r])`).
    const own = checker.getNonNullableType(absentSubstitutedTypeAt(node))
    if (!checker.isTupleType(own) && !(node.elements.length === 0 && checker.isArrayType(own))) return null
    const target = impliedPatternTargetOf(checker, node)
    if (!target) return null
    if (node.elements.some((element) => ts.isSpreadElement(element))) return null
    // A nested element's default (`[[x, y, z] = [4, 5, 6]]`) is stored in
    // THAT element's slot -- the census's own binding for it, which is the
    // outer array's element (a tuple record here) -- not in the root
    // parameter's: reading the root's slot typed this literal as an array OF
    // its own tuple and passed `4` into a three-field record.
    if (target.element) {
      const slot = parameters.typeAt(target.element)
      return slot && !isUnusableEvidence(slot) ? typeOf(slot) : null
    }
    // The parameter's census slot (every tuple arm's positions, joined) is
    // the element this literal is stored as; the literal's own tuple shape
    // is not, or `f([1, 2]); f([])` would pass a `never[]` into a `number[]`.
    const bound = target.parameter ? parameters.typeAt(target.parameter) : null
    const boundElement = target.parameter
      ? (impliedPatternArrayElementAt(checker, parameters, target.parameter) ??
        (bound ? checker.getIndexTypeOfType(checker.getNonNullableType(bound), ts.IndexKind.Number) : undefined))
      : undefined
    // A hole (`[,]`) is a position holding nothing -- the array's element
    // read there is `undefined`, which the pattern's own absence already
    // covers -- so it states no element type of its own.
    const written = node.elements
      .filter((element) => !ts.isOmittedExpression(element))
      .map((element) => checker.getBaseTypeOfLiteralType(absentSubstitutedTypeAt(element)))
    const element =
      boundElement && !isUnusableEvidence(boundElement)
        ? boundElement
        : written.length === 0
          ? checker.getNeverType()
          : widestOf(checker, written)
    if (!element) return null
    return table.intern({ kind: 'array', element: typeOf(element), readonly: false, extension: [] })
  }

  /**
   * A rest element of an array pattern over a plain array IS that array's
   * type -- the remaining elements, in an Array -- and the checker's own
   * answer is not: `var [x, ...rest] = [1, 2, 3]` types `rest` as the tuple
   * `[number, number]` because it typed the literal as a tuple, while the
   * value the pattern reads out of (`impliedPatternArrayLiteralType`) is an
   * ordinary array of unknown length. Answered for the element and for every
   * reference to it, since both are laid out from the same cell. A pattern
   * over a source that stays a tuple keeps the checker's tuple.
   *
   * Answers only for `rest` itself, never for a cell some OTHER assignment
   * also reaches. `rest = JSON.parse(...)` after `var [x, ...rest] = [1, 2,
   * 3]` is the identical defect `restAssignmentArrayShapeAt` (below) was
   * fixed for, one syntax over: this function is keyed by the symbol's
   * DECLARATION alone and, before this guard, never asked whether anything
   * else writes it, so a genuinely dynamic later value stored into `rest`
   * still read back as `array-object(scalar(number))` from the pattern
   * alone -- a fail-open `unboxDynamicArray<double>` that aborted the moment
   * the dynamic value held something else. See that function's own header
   * for the full trace; this is its DECLARATION-pattern twin.
   */
  const arrayPatternRestTypeAt = (node: ts.Node): StructuralTypeId | null => {
    const element = ts.isBindingElement(node)
      ? node
      : ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined
    if (!element || !ts.isBindingElement(element) || !element.dotDotDotToken || !ts.isArrayBindingPattern(element.parent)) return null
    if (flow) {
      const symbol = ts.isIdentifier(element.name) ? checker.getSymbolAtLocation(element.name) : undefined
      if (!symbol) return null
      // The element's OWN binding is itself recorded as a write (`destructuring`,
      // `value: null` -- `recordBindingPattern`), so a real value here is always
      // a SEPARATE, later assignment this function has no way to fold in.
      const reassigned = flow.writesToSymbol(symbol).some((write) => write.slot === 'whole' && write.value !== null)
      if (reassigned) return null
    }
    const source = mapper.typeAt(element.parent)
    return table.get(source).shape.kind === 'array' ? source : null
  }

  /**
   * A REST target of an array-destructuring ASSIGNMENT (`var a, r; [a, ...r]
   * = [1, 2, 3]`), for a bare `r` with no annotation and no initializer.
   *
   * `arrayPatternRestTypeAt` above answers the DECLARATION-pattern twin of
   * this (`var [x, ...rest] = ...`), where the rest names a `ts.BindingElement`
   * this layer can walk straight to the pattern from. An assignment target
   * names no such element -- `r` is an ordinary bare `VariableDeclaration`,
   * written later through `[a, ...r] = arr`, and `local-bindings.ts`'s
   * `identifierWritesOf` (which types every OTHER bare-declaration write
   * through a recovered `ts.Expression`) explicitly refuses a rest target:
   * there is no single sub-expression that states "the remaining elements,"
   * and there is no public checker API to synthesize one --
   * `structural-array-element.ts`'s header documents the identical wall for
   * `never[]`.
   *
   * The source array's OWN resolved carrier already answers the question
   * this layer needs, without synthesizing anything: a rest capture over an
   * `array`-shaped source holds exactly that source's element, whatever the
   * capture's start position -- the identical fact `arrayPatternRestTypeAt`
   * trades on. So this asks every REST write of the symbol for its pattern's
   * source, resolves that source through this same mapper, and adopts its
   * shape outright when it is an `array` -- never a `tuple`, which states a
   * fixed arity the rest slice does not share, and never anything else,
   * which states a value no array carrier could hold.
   *
   * Several rest writes to the same cell must AGREE (the identical shape) or
   * this refuses outright -- a real disagreement is not this layer's to
   * resolve, and a wrong pick would be worse than the box the cell keeps
   * today. A write whose source cannot be resolved to an array shape states
   * nothing either way and is skipped rather than treated as a conflict.
   *
   * The premise this whole function trades on is "`r` is written ONLY
   * through rest capture" (the header's own words: "written LATER through
   * `[a, ...r] = arr]`"). It used to take that on faith -- the write loop
   * below `continue`d past any write that was not itself a recognised rest
   * capture, silently discarding it rather than checking whether the
   * premise actually held. A plain `r = JSON.parse(...)` reassignment after
   * `[a, ...r] = [1, 2, 3]` reached exactly that `continue`, so this
   * function answered "array of number" from the ONE write it understood
   * while a genuinely dynamic value flowed into the SAME cell from the one
   * it ignored -- the store then read that dynamic value back through
   * `unboxDynamicArray<double>`, which aborted at runtime the moment the
   * parsed JSON held strings. Certified clean, compiled clean, `gea:
   * SIGABRT`. Fixed by refusing outright the moment ANY write this
   * authority cannot itself vouch for as a rest capture exists, rather than
   * silently answering from the subset it does understand -- the same
   * "a write that states nothing is not a write that disagrees, but a write
   * this authority never SAW is not evidence of agreement either" correction
   * `local-bindings.ts`'s `branchArmsOf` made for `||`/`??`/`?:` writes.
   */
  const restAssignmentArrayShapeAt = (node: ts.Node): StructuralTypeId | null => {
    if (!flow) return null
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.type ||
      declaration.initializer ||
      !ts.isIdentifier(declaration.name)
    )
      return null
    const symbol = checker.getSymbolAtLocation(declaration.name)
    if (!symbol) return null
    let agreed: StructuralTypeId | null = null
    let sawRestWrite = false
    for (const write of flow.writesToSymbol(symbol)) {
      if (write.slot !== 'whole') continue
      const target = write.edge === 'destructuring' && write.value === null && write.naming ? arrayAssignmentTargetOf(write.naming) : null
      if (!target || !ts.isSpreadElement(target.keyNode)) {
        // Not a rest capture this authority recognises -- a bare/defaulted
        // destructuring element, a plain reassignment, a reused for-of head,
        // whatever it is, it is a write this loop cannot fold into `agreed`,
        // so the "written ONLY through rest capture" premise is false and
        // the honest answer is refusal, not an answer from a subset.
        return null
      }
      sawRestWrite = true
      const source = arrayAssignmentPatternSourceExpression(target.pattern)
      if (!source) continue
      const sourceShape = mapper.typeAt(source)
      if (table.get(sourceShape).shape.kind !== 'array') continue
      if (agreed !== null && agreed !== sourceShape) return null
      agreed = sourceShape
    }
    return sawRestWrite ? agreed : null
  }

  /**
   * The copy a site's instantiation names, as a path this mapper can be asked
   * for: the copies enclosing the *site's* declaration, not this walk's whole
   * path. A generic named from inside an unrelated generic's body is not
   * nested in it, and carrying that outer step would compose `decl|X@0.0` --
   * an id the census, which walks that generic from its own scope, never
   * publishes.
   *
   * A SELF-instantiation (`Hono#clone()` naming `new Hono<...>` with its own
   * type parameters) resolves to the identical (declaration, ordinal) pair as
   * the enclosing path's own last step, since `prefixFor` is inclusive of
   * self-containment. Appending a second frame there composes `decl|Hono@0.0`
   * for a copy already named `decl|Hono@0` -- the spurious-nesting shape, one
   * step short -- so the enclosing path is reused unchanged when its last
   * step already IS this copy.
   */
  /**
   * The generic source function `type` is the OPEN type of, from this view.
   *
   * `typeof identity` where `function identity<T>(x: T): T` is a module-level
   * function with a body, read from a view that binds none of its type
   * parameters (the root, or a copy of something else). Inside `identity`'s
   * own copy the same `ts.Type` reads with `T` bound, and is the copy's own
   * closed callable, not a choice. Only a module- or namespace-level
   * declaration qualifies: a nested generic closes over its frame, and a
   * choice among closures would need the captured environment beside the
   * tag. See `StructuralShape`'s `generic` and `representation/model.ts`'s
   * `generic-function-set`.
   */
  const genericSourceFunctionOf = (
    type: ts.Type,
    callSignatures: readonly ts.Signature[],
    constructSignatures: readonly ts.Signature[],
    implementation: ts.Signature | null
  ): DeclarationId | null => {
    if (constructSignatures.length > 0 || callSignatures.length === 0) return null
    const signatures = implementation ? [implementation] : callSignatures
    // Open = this PATH binds none of it. Not `substituteTypeParameter`: that
    // also answers from the instantiation census's one-instantiation fallback,
    // which closes a root-view `T` whose only copy is the one a set call
    // minted -- reading the choice's own member as that copy's closed callable.
    const open = signatures.every((signature) => {
      const parameters = signature.getTypeParameters() ?? []
      return (
        parameters.length > 0 &&
        parameters.some((parameter) => {
          const declared = parameter.getSymbol()?.declarations?.[0]
          return declared === undefined || boundByPath(declared) === null
        })
      )
    })
    if (!open) return null
    const declaration = implementation?.declaration ?? type.getSymbol()?.valueDeclaration
    if (!declaration || !ts.isFunctionDeclaration(declaration) || declaration.body === undefined) return null
    if (declaration.getSourceFile().isDeclarationFile) return null
    if (!(ts.isSourceFile(declaration.parent) || ts.isModuleBlock(declaration.parent))) return null
    if (declaration.asteriskToken !== undefined || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) !== 0) return null
    return identities.declarationIdOf(declaration, rootSpecialization)
  }

  const copyPathOf = (site: { readonly declaration: ts.Declaration; readonly ordinal: number }): SpecializationPath => {
    const enclosing = identities.prefixFor(site.declaration, path)
    const last = enclosing[enclosing.length - 1]
    const isSelfReference = last !== undefined && last.owner === site.declaration && last.ordinal === site.ordinal
    return isSelfReference ? enclosing : [...enclosing, { owner: site.declaration, ordinal: site.ordinal }]
  }

  /**
   * The implementation signature behind a call-signature set that is one
   * overloaded SOURCE function or method -- two or more signatures, every one
   * declared by a body-less overload or the body of the same symbol, in a
   * source file -- or `null` for any other callable type. An ambient overload
   * set (`document.createElement`) has no body to be the value and keeps the
   * checker's answer.
   */
  const sourceOverloadImplementationOf = (
    callSignatures: readonly ts.Signature[],
    constructSignatures: readonly ts.Signature[]
  ): ts.Signature | null => {
    if (callSignatures.length < 2 || constructSignatures.length > 0) return null
    let symbol: ts.Symbol | undefined
    for (const signature of callSignatures) {
      const declaration = signature.getDeclaration()
      if (!declaration || !(ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))) return null
      if (declaration.getSourceFile().isDeclarationFile) return null
      const name = ts.getNameOfDeclaration(declaration)
      const owner = name ? checker.getSymbolAtLocation(name) : undefined
      if (!owner || (symbol !== undefined && owner !== symbol)) return null
      symbol = owner
    }
    const first = callSignatures[0]?.getDeclaration()
    return first ? implementationSignatureOf(checker, first) : null
  }

  /**
   * A member read off an EVOLVING array -- `var xs = []; xs.push('a')` -- whose
   * element the census proved (`inferredArrayElementAt`) but the checker still
   * carries as `any`/`never` at the read. The checker instantiates
   * `Array<T>.push` from the receiver EXPRESSION's type, so its signature says
   * `(...items: any[]) => number`, and every argument the call packs into that
   * rest slot is boxed on the way in and unboxed again by the native `push`
   * -- a `gea::Value` per pushed element for an array whose storage is
   * already `ArrayObject<std::string>`. Two authorities over one slot; the
   * census's element is the one the storage was chosen by, so it is the one
   * the member's own parameters carry too. Only the argument positions that
   * are the ELEMENT (`any`) or a rest of it (`any[]`) are rewritten -- the
   * shapes of `push`/`unshift`/`splice`/`indexOf`/`includes`/`fill` -- a
   * result or a nested callback stays the checker's, since nothing here is
   * asked about it and a wrong guess there is a silent miscompile.
   */
  const evolvingArrayMemberTypeAt = (node: ts.Node): StructuralTypeId | null => {
    if (!ts.isPropertyAccessExpression(node)) return null
    const element = inferredArrayElementAt(checker, collections, layoutTypeAt, node.expression)
    if (!element || (element.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) !== 0) return null
    // The checker's own member type, interned directly: asking `typeAt` of
    // this same node would re-enter here.
    const declared = typeOf(checker.getTypeAtLocation(node))
    const shape = table.get(declared).shape
    if (shape.kind !== 'signature' || shape.call.length !== 1 || shape.construct.length !== 0) return null
    // `any` for the evolving array the checker gave up on, `never` for the one
    // it is still tracking (`push` off a fresh `[]` is `(...items: never[])`).
    const unstated = new Set<StructuralTypeId>()
    for (const primitive of ['any', 'never'] as const) {
      const id = table.intern({ kind: 'primitive', primitive })
      unstated.add(id)
      unstated.add(table.intern({ kind: 'array', element: id, readonly: false, extension: [] }))
    }
    const elementId = typeOf(element)
    const elementArray = table.intern({ kind: 'array', element: elementId, readonly: false, extension: [] })
    const substitute = (id: StructuralTypeId): StructuralTypeId => {
      if (!unstated.has(id)) return id
      return table.get(id).shape.kind === 'array' ? elementArray : elementId
    }
    const call = shape.call[0]
    if (!call || !call.parameters.some((parameter) => unstated.has(parameter.type))) return null
    const parameters = call.parameters.map((parameter) => ({
      ...parameter,
      type: substitute(parameter.type),
      slot: substitute(parameter.slot)
    }))
    return table.intern({ kind: 'signature', call: [{ ...call, parameters }], construct: [] })
  }

  /**
   * The signature of a member read off a receiver the CENSUS typed and the
   * checker carries as `any` -- three's `LOD.addLevel` reading `levels`
   * through a descriptor-defined field -- when the member is an overload set
   * the census could not narrow to one convention: `memberTypeOf`'s
   * `singleConventionAt` needs the checker's resolved signature to pick, and a
   * call through an `any` receiver resolves to the fabricated no-parameter
   * signature instead. Picked here by the argument count, the checker's own
   * first overload-resolution step (`arityAdmittedSignature`), and interned as
   * the ONE selected signature over the census receiver's instantiation -- so
   * `levels.splice( l, 0, level )` names the rest-taking overload and the
   * lowering packs the item, where the joined overload set declared no rest
   * slot and the item reached `Array.prototype.splice`'s renderer bare.
   */
  const censusMemberSignatureAt = (node: ts.Node): StructuralTypeId | null => {
    if (!ts.isPropertyAccessExpression(node)) return null
    if ((absentSubstitutedTypeAt(node).flags & ts.TypeFlags.Any) === 0) return null
    const call = node.parent
    if (!call || !ts.isCallExpression(call) || call.expression !== node) return null
    const receiver = parameters.typeAt(node.expression)
    if (!receiver || (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return null
    const property = checker.getPropertyOfType(checker.getNonNullableType(receiver), node.name.text)
    if (!property) return null
    const member = checker.getTypeOfSymbolAtLocation(property, node)
    if (member.getCallSignatures().length < 2 || member.getConstructSignatures().length > 0) return null
    const selected = arityAdmittedSignature(member, call)
    if (!selected || (selected.getTypeParameters()?.length ?? 0) > 0) return null
    return table.intern({ kind: 'signature', call: [signatureOf(selected)], construct: [] })
  }

  /**
   * `Object.getOwnPropertyDescriptor(receiver, key)`'s result, minted from the
   * RECEIVER's own structural shape rather than the ambient `PropertyDescriptor`
   * interface's own declared `value?: any`.
   *
   * The library's own signature is `getOwnPropertyDescriptor(o: any, p:
   * PropertyKey): PropertyDescriptor | undefined` -- fixed and non-generic, so
   * every call resolves to the identical ambient shape no matter what `o` is.
   * That is the right answer for a receiver this compiler never gave a shape of
   * its own (`Math`, `Array.prototype`, a value the program declared `any`):
   * there is no narrower fact to publish, and `value: any` is honest. It is the
   * wrong answer for a record literal, an array, or an in-program function,
   * whose OWN declared members already answer "what is `receiver[key]`" -- and
   * publishing the ambient `any` there is exactly the "typed value lowered into
   * `gea_cpp_value`" defect this compiler exists to refuse:
   * `Object.getOwnPropertyDescriptor({ a: 1 }, "a").value` would box a `number`
   * the record's own layout already states, for no reason but the library
   * text's own `any`.
   *
   * Lives here, in `typeAt`'s own module, rather than beside
   * `producers/invocations.ts`'s other result overrides: this is asked of the
   * bare CallExpression node ITSELF (not just consulted from inside the
   * invocation producer's own result computation), because `context.types.typeAt`
   * is the ONE authority every OTHER consumer of this same node's type reads
   * from -- a property access's own receiver type
   * (`producers/properties.ts`), a local binding's declared type
   * (`local-bindings.ts`) -- and an override that only changed what the
   * invocation producer PUBLISHES for its own operation result left every one
   * of those asking `context.types.typeAt` on the very same node with the
   * old, ambient, boxed answer: the call's own SSA value came out fully
   * native while the record it got stored into, and the receiver of a plain
   * `d.value` off it, still boxed. `evolvingArrayMemberTypeAt` above is
   * exposed the same way for the identical reason.
   *
   * Gated to receivers this compiler already treats as having a REAL,
   * in-program shape: `membersDropped === false` for an object literal
   * (`membersDropped` is `true` for an ambient interface enumerated
   * `data-only`, `host/object-protocol.ts`'s own distinction between the two),
   * and a physical, non-ambient value declaration for a function. A host
   * intrinsic still falls through to the ambient signature below untouched --
   * its own static reflection, if any, is a separate, host-table-driven
   * mechanism this function has no business pre-empting.
   *
   * A literal key that names a member answers with that member's own type. A
   * runtime key, or a literal that names no member, answers with the union of
   * every member this receiver states (an array: its element and `length`; a
   * function: `name` and `length`), plus the record's dynamic-property
   * SIDECAR's own boxed arm for a key `Object.defineProperty` could have
   * added after the fact -- the one accepted, bounded exception this feature
   * carries, matching the sidecar's own storage
   * (`emit-dynamic-properties.ts`).
   */
  const objectDescriptorReturnTypeAt = (call: ts.Node): StructuralTypeId | null => {
    if (!ts.isCallExpression(call)) return null
    const node = call.expression
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'getOwnPropertyDescriptor') return null
    if (!isIntrinsicDescriptorCall(call)) return null
    const target = call.arguments[0]
    const keyArgument = call.arguments[1]
    if (!target) return null
    const literalKey = keyArgument
      ? ts.isStringLiteralLike(keyArgument)
        ? keyArgument.text
        : ts.isNumericLiteral(keyArgument)
          ? keyArgument.text
          : null
      : null
    const intern = (built: StructuralShape): StructuralTypeId => table.intern(built)
    const boolId = intern({ kind: 'primitive', primitive: 'boolean' })
    // The `value` this descriptor carries for one candidate receiver shape, or
    // `null` when this shape names no rendering this feature supports (a plain
    // `dynamic`/`unknown` receiver, an interface flattened to `membersDropped`).
    // Split out of the top level so a receiver typed as a UNION of shapes --
    // `describe(obj, key)` called once with a record and once with an array,
    // neither call site specializing the shared body -- can ask this same
    // question of each arm and union the answers, rather than refusing the
    // whole call the way an unhandled `shape.kind` correctly does.
    // `any | T` is `any`: an arm that already admits every value absorbs the
    // others, exactly as the checker reduces the same union. Interning the
    // unreduced pair instead published `tagged-union(dynamic | number)` for
    // `Array.prototype`'s `any` element, a carrier no installed conversion
    // reaches from the boxed read the array arm performs, and the whole call
    // was refused for a receiver whose honest answer was simply `any`.
    const anyId = intern({ kind: 'primitive', primitive: 'any' })
    const unionOf = (arms: readonly StructuralTypeId[]): StructuralTypeId => {
      const distinct = [...new Set(arms)]
      if (distinct.includes(anyId)) return anyId
      const first = distinct[0]
      return distinct.length === 1 && first !== undefined ? first : intern({ kind: 'union', members: distinct })
    }
    const valueIdOfShape = (shape: StructuralShape): StructuralTypeId | null => {
      // A native class anchor carries its own member layout in the same body
      // as an ordinary declared record. Discarding that body here widens a
      // known field into ambient PropertyDescriptor.value:any before the
      // result is even lowered, forcing a needless box/unbox round trip.
      if ((shape.kind === 'declared' || shape.kind === 'class-instance') && shape.body !== null)
        return valueIdOfShape(table.get(shape.body).shape)
      if (shape.kind === 'object' && !shape.membersDropped) {
        if (literalKey !== null) {
          // A literal key that names no member this record's own structural
          // type declares is not proof the key is absent: `Object.defineProperty(o,
          // "b", ...)` adds "b" to the object's dynamic-property SIDECAR (see
          // `emit-dynamic-properties.ts`), which this type never sees, because
          // a record's structural shape only ever tracks its declared literal
          // fields. The sidecar stores its values boxed (`gea::Value` -- the
          // one accepted, bounded exception this feature carries, matching a
          // genuinely dynamic key with no static type to give it), so the
          // descriptor's `value` for a key the shape doesn't declare must stay
          // `dynamic` rather than borrowing an unrelated declared field's type.
          const match = shape.members.find((member) => member.key.kind === 'string' && member.key.value === literalKey)
          if (match) return match.type
          const index = shape.index.find(
            (candidate) =>
              candidate.key === 'string' || (candidate.key === 'number' && literalKey !== '' && Number.isFinite(Number(literalKey)))
          )
          return index?.value ?? intern({ kind: 'primitive', primitive: 'any' })
        } else if (shape.members.length > 0) {
          // A runtime (non-literal) key: `describe(obj, key)`'s `value` must
          // be able to hold whichever declared field `key` names at runtime,
          // so it is the union of the record's own field types -- the
          // emitter renders this as a switch over the record's known keys
          // (`finiteRecordUnionGetText`'s pattern), never a boxed carrier. A
          // runtime key can ALSO name a key the type declares nothing about,
          // so the value must also admit the sidecar's own boxed arm, exactly
          // as the literal-miss case above does, or a key the switch does not
          // recognize has nowhere sound to fall through to.
          const arms = [...new Set(shape.members.map((member) => member.type))]
          const keyType = keyArgument ? checker.getTypeAtLocation(keyArgument) : null
          const index = shape.index.find(
            (candidate) =>
              keyType !== null &&
              ((candidate.key === 'string' && (keyType.flags & ts.TypeFlags.StringLike) !== 0) ||
                (candidate.key === 'number' && (keyType.flags & ts.TypeFlags.NumberLike) !== 0) ||
                (candidate.key === 'symbol' && (keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0))
          )
          arms.push(index?.value ?? intern({ kind: 'primitive', primitive: 'any' }))
          // Through `unionOf`, like every sibling branch: an unreduced
          // `any | number` pair published `tagged-union(dynamic | number)`
          // for the `?.value` read, and the optional chain's `undefined`
          // arm has no conversion into that carrier, so a
          // `getOwnPropertyDescriptor(item, String(key))?.value` was refused
          // where its honest answer, as for `Array.prototype`'s element
          // above, is simply `any`.
          return unionOf(arms)
        }
        return null
      }
      if (shape.kind === 'array') {
        const numberId = intern({ kind: 'primitive', primitive: 'number' })
        if (literalKey === 'length') return numberId
        // An index's descriptor `value` is the STORED element, and an Array's
        // storage admits the language's `undefined` at a present index
        // independently of what its element type says: 12.9.6 gives a tagged
        // template's invalid escape an `undefined` cooked element inside an
        // array the checker still types `string`, and the runtime carries
        // exactly that as `ArrayObject`'s `undefineds` bit beside its element.
        // Answering with a bare `shape.element` gave the descriptor record no
        // carrier for that case, so the emitter proved the read unreachable
        // and `test/runtime/template-strings-array-identity.ts` aborted on
        // `gea::host::unreachableValue<std::string>()` -- with the emitter
        // side already correct (`indexDescriptor` in
        // `targets/cpp/host/emit-host-object.ts` handles the absent value) and
        // simply fed a false premise. Only the reflective read widens: a
        // TYPED read of the same index still publishes the element, because
        // the element type is what a typed read is entitled to.
        if (literalKey !== null && /^(0|[1-9]\d*)$/.test(literalKey))
          return unionOf([shape.element, intern({ kind: 'primitive', primitive: 'undefined' })])
        // `extension` is the data an interface ADDS to the Array it extends --
        // `TemplateStringsArray`'s own `raw`, or `NodeArray<T>`'s `pos`/`end`.
        // A literal key naming one of those fields answers with that field's
        // OWN type: it is not an element (the element type is a red herring
        // for it) and not the generic "any other key" case either. Missing
        // this let `Object.getOwnPropertyDescriptor(templateStrings,
        // "raw").value` -- an array-object -- fall into the element/number
        // union below and mint `TaggedUnion<std::string, double>`, which then
        // refused every real read of `raw`'s array value at runtime.
        if (literalKey !== null) {
          const extensionMatch = shape.extension.find((member) => member.key.kind === 'string' && member.key.value === literalKey)
          if (extensionMatch) return extensionMatch.type
        } else if (shape.extension.length > 0) {
          // A runtime key can equally name an extension field, so it must be
          // in the union the same way a record's runtime-key case unions its
          // declared members above.
          return unionOf([shape.element, numberId, ...shape.extension.map((member) => member.type)])
        }
        return unionOf([shape.element, numberId])
      }
      if (shape.kind === 'signature') {
        const name = ts.isPropertyAccessExpression(target) ? target.name : ts.isIdentifier(target) ? target : null
        const symbol = name ? checker.getSymbolAtLocation(name) : undefined
        const declaration = symbol ? identities.valueDeclarationOfSymbol(symbol) : null
        // A host's own method (`Date.prototype.getTime`, `Array.from`) answers
        // the same two questions with the same two types: 10.2.10's `name`
        // and `length` are what a builtin function owns, and the emitter reads
        // both off the callable's facts. What stays refused is a callable
        // interface with declared members of its own, whose `name` could be
        // a data member the declaration states.
        // An OVERLOADED host method (`Array.from`, 4 signatures) stays on the
        // boxed path: its value has no single calling convention to carry,
        // so the typed descriptor arm could not receive it.
        const isRealFunction =
          declaration &&
          (ts.isFunctionDeclaration(declaration) ||
            ts.isFunctionExpression(declaration) ||
            ts.isArrowFunction(declaration) ||
            ((ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && shape.call.length === 1))
        if (!isRealFunction) return null
        const stringId = intern({ kind: 'primitive', primitive: 'string' })
        const numberId = intern({ kind: 'primitive', primitive: 'number' })
        if (literalKey === 'name') return stringId
        if (literalKey === 'length') return numberId
        return intern({ kind: 'union', members: [stringId, numberId] })
      }
      if (shape.kind === 'union') {
        const arms: StructuralTypeId[] = []
        for (const member of shape.members) {
          const memberValueId = valueIdOfShape(table.get(member).shape)
          if (memberValueId === null) return null
          if (!arms.includes(memberValueId)) arms.push(memberValueId)
        }
        if (arms.length === 0) return null
        return unionOf(arms)
      }
      return null
    }
    const valueId = valueIdOfShape(table.get(mapper.typeAt(target)).shape)
    if (valueId === null) return null
    const descriptor = intern({
      kind: 'object',
      members: [
        { key: { kind: 'string', value: 'value' }, type: valueId, optional: false, readonly: false, accessor: null },
        { key: { kind: 'string', value: 'writable' }, type: boolId, optional: false, readonly: false, accessor: null },
        { key: { kind: 'string', value: 'enumerable' }, type: boolId, optional: false, readonly: false, accessor: null },
        { key: { kind: 'string', value: 'configurable' }, type: boolId, optional: false, readonly: false, accessor: null }
      ],
      index: [],
      membersDropped: false
    })
    return intern({ kind: 'union', members: [descriptor, intern({ kind: 'primitive', primitive: 'undefined' })] })
  }

  // `X.prototype` on an ambient constructor. The checker types the slot as the
  // INSTANCE type, and following that answer makes `Date.prototype` a Date --
  // the same carrier as `new Date()`, which is exactly the object it is not:
  // reflection over it (`hasOwnProperty`, `getOwnPropertyDescriptor`, the
  // property helper's delete/restore) asks about the prototype's OWN
  // members. `bindHostObjectClosure` registers the slot's declaration as a
  // protocol of its own; this anchors a declared shape on that declaration,
  // carrying the instance's body so the member reads keep their signatures.
  const borrowedPrototypeMethodNames = new Set(['call', 'apply', 'bind'])
  // The ambient constructors whose `.prototype` methods, read as values, carry
  // an invoke that brand-checks a boxed receiver and dispatches to the
  // instance's own member (`hostPrototypeMethodValueText`, targets/cpp). A
  // constructor is added here only together with that dispatch: without it a
  // borrow through the prototype's method would compile to a callable that
  // throws for every receiver, which is a wrong answer where the instance
  // path at least refuses.
  const receiverDispatchingPrototypes = new Set(['Date'])
  /**
   * Prototype members whose `[[Call]]` is GENERIC over the receiver -- ECMA-262
   * 21.4.4.37 `Date.prototype.toJSON` runs ToPrimitive(this, number) and then
   * invokes `toISOString` on whatever it was given, never a brand check -- so
   * the boxed-receiver stub (`hostPrototypeMethodValueText`), whose invoke IS
   * a brand check, would render a borrow of it as a TypeError the language does
   * not throw. Such a borrow keeps the instance path's compile-time refusal
   * until the target states the generic form (ToPrimitive over a boxed value is
   * a runtime capability it does not carry yet); the VALUE read still renders,
   * so `name`/`length`/descriptor reflection over the member is untouched.
   */
  const receiverGenericPrototypeMembers = new Set(['toJSON'])
  const prototypeObjectTypeAt = (node: ts.Node): StructuralTypeId | null => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'prototype') return null
    const receiverType = checker.getTypeAtLocation(node.expression)
    if (receiverType.getConstructSignatures().length === 0) return null
    const slot = checker.getPropertyOfType(receiverType, 'prototype')
    const declaration = slot?.valueDeclaration ?? slot?.declarations?.[0]
    if (!slot || !declaration || !declaration.getSourceFile().isDeclarationFile) return null
    const instanceType = checker.getTypeOfSymbolAtLocation(slot, declaration)
    // `String.prototype.trim.call(s)` borrows the INSTANCE method: the read
    // off the prototype is the method the instance carrier already renders,
    // and the borrow lowers through it (`deferredFunctionCallCalleeOf`). A
    // prototype whose methods dispatch on a boxed receiver in the target
    // (`receiverDispatchingPrototypes`) has no use for that path: its own
    // method IS the borrow, brand check included, for a Date receiver and for
    // the this-value cases alike -- and the instance path never rendered the
    // `X.prototype` operand it needs (a handle into an instance cell).
    const member = node.parent
    if (ts.isPropertyAccessExpression(member) && member.expression === node) {
      const borrow = member.parent
      if (ts.isPropertyAccessExpression(borrow) && borrow.expression === member && borrowedPrototypeMethodNames.has(borrow.name.text)) {
        if (
          !receiverDispatchingPrototypes.has(instanceType.getSymbol()?.name ?? '') ||
          receiverGenericPrototypeMembers.has(member.name.text)
        ) {
          return null
        }
      }
    }
    const instance = table.get(typeOf(instanceType)).shape
    // `Object.prototype`: the ONE ambient instance interface `typeOf`
    // deliberately collapses to `any` everywhere else
    // (`derived-expression-type.ts`'s `isGlobalObjectInterface` -- a
    // `: Object`-typed value states nothing, and that collapse is measured
    // and load-bearing, so it must keep firing for every OTHER read of this
    // exact `ts.Type`). This one occurrence names the SLOT itself, not an
    // ordinary Object-typed value: the declared shape it anchors is keyed by
    // the `prototype` slot's own declaration id, never by `instanceType`'s
    // shared identity, so it can safely carry a body the collapsed cache does
    // not. `Object`'s instance interface declares no DATA members at all --
    // `toString`/`valueOf`/`hasOwnProperty`/`isPrototypeOf`/
    // `propertyIsEnumerable`/`toLocaleString` are all methods -- so an empty
    // ambient body is the exact starting point `prototypeMethodBodyOf` needs
    // to inject them, the same way an ordinary ambient interned body is for
    // Date/RegExp/Boolean/String/Number.
    const dataBody =
      instance.kind === 'declared'
        ? instance.body
        : isGlobalObjectInterface(checker, declaration, instanceType)
          ? table.intern({ kind: 'object', members: [], index: [], membersDropped: true })
          : null
    if (instance.kind !== 'declared' && dataBody === null) return null
    const id = identities.declarationIdOf(declaration)
    const { id: anchor, fresh } = table.anchor(`declared:${id}:`)
    if (fresh)
      table.complete(anchor, {
        kind: 'declared',
        declaration: id,
        typeArguments: [],
        body: prototypeMethodBodyOf(dataBody, instanceType)
      })
    return anchor
  }

  // The prototype object's body: the instance's data members, plus every
  // method the instance interface declares -- an ambient body is interned
  // DATA-ONLY (`membersDropped`), and the prototype is exactly the object
  // whose own members those methods are. A prototype method read as a VALUE
  // takes its receiver from whoever calls it -- `getTime.call(0)`,
  // `getTime.call(new Date())` -- and 21.4.4's `thisTimeValue(this value)`
  // decides at that moment whether it is a Date. An interface method's
  // signature carries no receiver (its `this` is the instance, implicitly,
  // never a physical slot), so the prototype's copy of each method states
  // one: `any`, the carrier that holds every value a caller may pass. The
  // emitted callable (`hostPrototypeMethodValueText`) performs the brand
  // check on it.
  const prototypeMethodBodyOf = (body: StructuralTypeId | null, instanceType: ts.Type): StructuralTypeId | null => {
    if (body === null) return null
    const shape = table.get(body).shape
    if (shape.kind !== 'object') return body
    const receiver = table.intern({ kind: 'primitive', primitive: 'any' })
    const methods: StructuralMember[] = []
    for (const symbol of checker.getPropertiesOfType(instanceType)) {
      const method = symbol.declarations?.find(ts.isMethodSignature)
      if (!method || shape.members.some((member) => member.key.kind === 'string' && member.key.value === symbol.getName())) continue
      const type = table.get(typeOf(checker.getTypeOfSymbolAtLocation(symbol, method))).shape
      if (type.kind !== 'signature' || type.call.length === 0) continue
      // An overloaded method (`toLocaleDateString(): string` beside
      // `(locales?, options?): string`) is one function object with one
      // frame; the copy states its widest overload, which every narrower
      // call fits through its optionals.
      const widest = type.call.reduce((best, signature) => (signature.parameters.length > best.parameters.length ? signature : best))
      methods.push({
        key: { kind: 'string', value: symbol.getName() },
        type: table.intern({ ...type, call: [{ ...widest, thisParameter: receiver }] }),
        optional: false,
        readonly: false,
        accessor: null
      })
    }
    return table.intern({ ...shape, members: [...shape.members, ...methods], membersDropped: false })
  }

  // A method read off the prototype object (`Date.prototype.getTime`, or
  // `obj.getTime` where `obj` is the prototype through a parameter) is the
  // prototype's own copy of it -- the receiver-taking signature above -- not
  // the instance's, which is what the checker answers for the access.
  const prototypeObjectMemberTypeAt = (node: ts.Node): StructuralTypeId | null => {
    if (!ts.isPropertyAccessExpression(node)) return null
    const receiver = prototypeObjectTypeAt(node.expression) ?? prototypeObjectParameterTypeAt(node.expression)
    if (receiver === null) return null
    const shape = table.get(receiver).shape
    if (shape.kind !== 'declared' || shape.body === null) return null
    const body = table.get(shape.body).shape
    if (body.kind !== 'object') return null
    const member = body.members.find((candidate) => candidate.key.kind === 'string' && candidate.key.value === node.name.text)
    return member?.type ?? null
  }

  // A local initialized to the prototype object or one of its methods
  // (`var getTime = Date.prototype.getTime`) and never written again holds
  // exactly that value: the declaration and every read of it answer the
  // prototype's own type, ahead of the local census, whose ts.Type-space
  // answer is the instance's. Asked at the declaration AND at each reference
  // so the cell and its reads cannot disagree (the trap the note at the top
  // of `typeAt` describes).
  const prototypeObjectLocalTypeAt = (node: ts.Node): StructuralTypeId | null => {
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : ts.isIdentifier(node) && !ts.isVariableDeclaration(node.parent)
        ? (checker.getSymbolAtLocation(node)?.valueDeclaration ?? null)
        : null
    if (declaration === null || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isIdentifier(declaration.name))
      return null
    const initializer = declaration.initializer
    if (!ts.isPropertyAccessExpression(initializer)) return null
    const writes = flow?.writesToDeclaration(declaration) ?? null
    // Only a WHOLE-slot write re-binds the cell; `f[k] = v` on the held method
    // (propertyHelper's `isWritable` writing `length`) is a member write on
    // the function object the cell keeps holding.
    if (writes === null || writes.some((write) => write.slot === 'whole' && write.value !== initializer)) return null
    return prototypeObjectMemberTypeAt(initializer) ?? prototypeObjectTypeAt(initializer)
  }

  // A parameter every call site hands `X.prototype` to, and every read of it:
  // the census bound it to the checker's image of the argument (the instance
  // type), so it is re-asked here from the argument expressions themselves.
  // One disagreeing site returns the question to the census's answer.
  const prototypeObjectParameterTypeAt = (node: ts.Node, visiting: Set<ts.ParameterDeclaration> = new Set()): StructuralTypeId | null => {
    const parameter = ts.isParameter(node)
      ? node
      : ts.isIdentifier(node) && !ts.isParameter(node.parent)
        ? (checker.getSymbolAtLocation(node)?.valueDeclaration ?? null)
        : null
    if (parameter === null || !ts.isParameter(parameter) || visiting.has(parameter)) return null
    const passed = parameters.argumentsAt?.(parameter) ?? null
    if (passed === null || passed.length === 0) return null
    visiting.add(parameter)
    let agreed: StructuralTypeId | null = null
    for (const argument of passed) {
      // The handle travels through helper calls (`verifyProperty(obj, ...)`
      // forwards `obj` to `isWritable(obj, ...)`), so an argument that is
      // itself such a parameter is asked the same question.
      const own =
        prototypeObjectTypeAt(argument) ??
        prototypeObjectMemberTypeAt(argument) ??
        prototypeObjectLocalTypeAt(argument) ??
        prototypeObjectParameterTypeAt(argument, visiting)
      if (own === null || (agreed !== null && agreed !== own)) return null
      agreed = own
    }
    return agreed
  }

  // The SIGNATURE side of the `unstated-never-array` rule's parameter form.
  // A parameter the collection census refused as part of an array's alias
  // component carries the box the caller's own cell carries; without this the
  // body's binding reads that box while the ABI still declares the checker's
  // image of the parameter, and `projection/abi.ts` refuses the convention
  // with "parameter N is bound as X but the ABI declares Y".
  const refusedArrayParameterTypeAt = (parameter: ts.ParameterDeclaration): StructuralTypeId | null => {
    if (!unstatedNeverArray(checker, collections, layoutTypeAt, parameter)) return null
    return table.intern({
      kind: 'array',
      element: table.intern({ kind: 'primitive', primitive: 'any' }),
      readonly: false,
      extension: []
    })
  }

  /** A callable type with the receiver its signatures state removed: what `Function.prototype.bind` produces. */
  const withoutReceiver = (id: StructuralTypeId): StructuralTypeId => {
    const shape = table.get(id).shape
    if (shape.kind === 'union') return table.intern({ ...shape, members: shape.members.map(withoutReceiver) })
    if (shape.kind !== 'signature' || shape.call.every((call) => call.thisParameter === null)) return id
    return table.intern({ ...shape, call: shape.call.map((call) => ({ ...call, thisParameter: null })) })
  }

  const boundCallResultAt = (node: ts.Node): StructuralTypeId | null =>
    ts.isCallExpression(node) && builtinBindSignatureAt(node.expression) ? withoutReceiver(typeOf(checker.getTypeAtLocation(node))) : null

  /**
   * `const readFile = host.readFile.bind(host)`: the cell, and every read of
   * it, holds what the bind produced. The checker types both with the
   * METHOD's own type (the same object `OmitThisParameter` hands back), so
   * the answer has to come from the initializer. A `let` keeps the checker's
   * type: a later write may store a method value the cell then has to bind.
   */
  const boundCellResultAt = (node: ts.Node): StructuralTypeId | null => {
    const declaration = ts.isVariableDeclaration(node)
      ? node
      : ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.type !== undefined || !declaration.initializer) return null
    if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return null
    return boundCallResultAt(declaration.initializer)
  }

  /** The one `Function.prototype.bind` overload this call site resolved to, or `null` where the read is not that. */
  const builtinBindSignatureAt = (node: ts.Node): ts.Signature | null => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'bind') return null
    const call = node.parent
    if (!ts.isCallExpression(call) || call.expression !== node) return null
    // `host.realpath?.bind(host)`: an optional link's own type is the union
    // with the absence, which declares no call signature at all -- the
    // callable this binds is the payload.
    const receiver = checker.getNonNullableType(checker.getTypeAtLocation(node.expression))
    if (checker.getSignaturesOfType(receiver, ts.SignatureKind.Call).length === 0) return null
    if (checker.getNonNullableType(checker.getTypeAtLocation(node)).getCallSignatures().length < 2) return null
    const resolved = checker.getResolvedSignature(call)
    // Only the ambient declaration's own overloads: a program declaring its
    // own `bind` member keeps whatever its declaration states.
    return resolved?.declaration?.getSourceFile().isDeclarationFile ? resolved : null
  }

  /** Whether `node` is a `for (const key in object)` head the loop declares, or a read of one. */
  const forInKeyAt = (node: ts.Node): boolean => {
    // The declaration node itself is what `producers/bindings.ts` asks for the
    // cell's carrier; an identifier is every read of it.
    const declarations = ts.isVariableDeclaration(node)
      ? [node]
      : ts.isIdentifier(node)
        ? (checker.getSymbolAtLocation(node)?.declarations ?? [])
        : []
    const declaration = declarations.length === 1 ? declarations[0] : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list)) return false
    const statement = list.parent
    return ts.isForInStatement(statement) && statement.initializer === list
  }

  /**
   * What a binding pattern's own INITIALIZER is worth to the pattern.
   *
   * Normally the initializer expression itself, which is what the pattern
   * destructures. An `as`/`satisfies`/`!`/`<T>x` wrapper is the exception, and
   * only when what it wraps is an ARRAY: those wrappers evaluate to nothing of
   * their own (`producers/erasure.ts`), so `citeExpressionResult` cites the
   * WRAPPED expression's result -- and the pattern that then reads that result
   * by index was being typed off the assertion instead. hono's
   * `defineWebSocketHelper` writes the shape exactly: `const [createEvents,
   * options] = args as [(c: Ctx) => Events, number?]` over a rest parameter,
   * whose value is one Array. `lower-destructuring.ts` refused the pair --
   * 'an array binding pattern's source resolved to "array-object(...)", but its
   * own iterator-record result selected "record(...)"' -- and it was right to:
   * the two really did describe different values.
   *
   * The assertion is not discarded, it is put where it belongs. A tuple
   * assertion over an array states the ARITY and the per-position types the
   * program is claiming, which the element reads still take from the pattern's
   * raw checker type (`producers/destructuring.ts`'s `elementTypeOf` asks
   * `isTupleType` of it); what it cannot state is a different CARRIER, because
   * `as` performs no conversion. Gated on the wrapped value actually being an
   * array so nothing else moves: an assertion over a `foo()` whose own type is
   * `unknown` keeps answering from the assertion, where it is the only thing
   * that states anything at all.
   */
  const patternSourceTypeAt = (initializer: ts.Expression): StructuralTypeId => {
    const erased = unwrapErasedExpression(initializer)
    if (erased === initializer) return mapper.typeAt(initializer)
    const source = mapper.typeAt(erased)
    return table.get(source).shape.kind === 'array' ? source : mapper.typeAt(initializer)
  }

  /**
   * Every step of `typeAt`, in the order the chain asked them.
   *
   * the frontend's evidence-policy tables. This was thirty-nine `if (answer)
   * return answer` statements whose ORDER was the answer wherever two of them
   * could speak for one node -- and which of them could was not written down
   * anywhere, because an `if` states no domain. Stating each step as a rule
   * that names the FORMS it serves makes the domain a declaration: a rule that
   * cannot answer for a node is never asked, and two rules claiming one form
   * are a disagreement `GEA_STRUCTURAL_DISAGREEMENT` can name, rather than a
   * precedence nobody chose.
   *
   * Order is preserved exactly as the chain had it, so this port changes no
   * answer. `forms: null` means the step's own first test is not a node-kind
   * test, so its domain is still unknown and order still decides for it; each
   * one is a row this phase owes a form, and the count of them is the honest
   * measure of how far the port has got.
   */
  const mutableMethods = createMutableMethodResolver(
    checker,
    table,
    flow,
    signatureOf,
    (node) => mapper.typeAt(node),
    (node) => mapper.rawTypeAt(node)
  )
  const structuralRules: readonly StructuralRule[] = [
    {
      name: 'mutable-method-storage',
      forms: [ts.SyntaxKind.PropertyAccessExpression, ts.SyntaxKind.ElementAccessExpression],
      resolve: mutableMethods.readTypeAt
    },
    {
      // A CommonJS wrapper's `module` is not the ambient `{ exports: any }`
      // silhouette when the source itself proves one exact top-level callable
      // export.  Keep the record local to that source module and map the same
      // expression at `module.exports` and a resolved `require` so a binding
      // cannot store a function while its read asks for a dynamic record.
      name: 'module-exports-record',
      forms: [ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const moduleExport = moduleRecords.moduleExportExpressionAt(node)
        if (moduleExport) {
          return table.intern({
            kind: 'object',
            members: [
              {
                key: { kind: 'string', value: 'exports' },
                type: mapper.typeAt(moduleExport),
                optional: false,
                readonly: false,
                accessor: null
              }
            ],
            index: [],
            membersDropped: false
          })
        }
        return null
      }
    },
    {
      name: 'exported-expression',
      // The erasure wrappers are in the domain because `unwrapExpression` peels
      // them before testing for an `exports` access, so the node ASKED about can
      // be the wrapper rather than the access underneath it.
      forms: [
        ts.SyntaxKind.PropertyAccessExpression,
        ts.SyntaxKind.ElementAccessExpression,
        ts.SyntaxKind.ParenthesizedExpression,
        ts.SyntaxKind.AsExpression,
        ts.SyntaxKind.TypeAssertionExpression,
        ts.SyntaxKind.NonNullExpression,
        ts.SyntaxKind.SatisfiesExpression,
        ts.SyntaxKind.PartiallyEmittedExpression,
        ts.SyntaxKind.CallExpression
      ],
      resolve: (node) => {
        const exported = moduleRecords.exportExpressionAt(node) ?? moduleRecords.requiredExportExpressionAt(node)
        if (exported) return mapper.typeAt(exported)
        return null
      }
    },
    {
      // `undefined as unknown as number` -- the shape every hand-written
      // iterator's `done: true` result has. An assertion is not a conversion:
      // the value that actually arrives is still the literal, and the asserted
      // type is only what consumers must accept. Publishing the asserted type
      // alone gave `{ value: undefined as unknown as number }` a `double` field,
      // and the emitter then had nowhere to put an `undefined` that faults --
      // `cppConstantLiteral` refuses a `double` for exactly that reason, so the
      // absence has to be in the carrier or the program has no honest emission.
      name: 'absence-assertion',
      forms: [ts.SyntaxKind.AsExpression, ts.SyntaxKind.TypeAssertionExpression],
      resolve: (node) => {
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
          const inner = unwrapErasedExpression(node.expression)
          const absent =
            inner.kind === ts.SyntaxKind.NullKeyword ? 'null' : ts.isIdentifier(inner) && inner.text === 'undefined' ? 'undefined' : null
          if (absent !== null) {
            const asserted = typeOf(checker.getTypeAtLocation(node))
            return table.intern({ kind: 'union', members: [asserted, table.intern({ kind: 'primitive', primitive: absent })] })
          }
        }
        return null
      }
    },
    {
      // A `for (const key in object)` head, and every read of it. The language
      // answers outright and without reference to the object: for-in enumerates
      // own enumerable STRING keys. TypeScript spells the binding
      // `Extract<keyof T, string>` so an index back into the same object narrows,
      // and inside a generic that spelling stays a conditional the checker
      // defers -- so the binding and every read in the loop body published an
      // unresolved carrier. tsc's `assign` and `copyProperties` are the measured
      // case; the census answers `string` for the bare-identifier and
      // destructured heads already, and a head the loop DECLARES had no rule.
      name: 'for-in-key-is-a-string',
      forms: [ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        if (forInKeyAt(node)) return typeOf(checker.getStringType())
        return null
      }
    },
    {
      // A binding, a read of it, or the choice expression itself, holding one of
      // several generic source functions: the union of the members' OPEN types,
      // never the checker's subtype-reduced declared type -- see
      // `generic-function-choice.ts`. Interned through this view's `typeOf`, so
      // a member whose type parameters THIS path binds (its own copy) reads as
      // that copy's closed callable, exactly as its bare name would.
      name: 'generic-function-choice',
      forms: [
        ts.SyntaxKind.ConditionalExpression,
        ts.SyntaxKind.BinaryExpression,
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.Identifier,
        ts.SyntaxKind.PropertyAccessExpression,
        ts.SyntaxKind.ParenthesizedExpression,
        ts.SyntaxKind.AsExpression,
        ts.SyntaxKind.NonNullExpression,
        ts.SyntaxKind.SatisfiesExpression,
        ts.SyntaxKind.TypeAssertionExpression
      ],
      resolve: (node) => {
        const choice = genericFunctionChoiceMembersOf(checker, node)
        if (choice) {
          return table.intern({
            kind: 'union',
            members: choice.map((member) => typeOf(checker.getTypeAtLocation(member.name ?? member)))
          })
        }
        return null
      }
    },
    {
      // A generic source function handed to a slot that states ONE closed
      // signature: `match: typeof match<Router<T>, T> = match` (hono's
      // `RegExpRouter`), `const f: (x: number) => number = identity`.
      //
      // The checker's type for the name is the OPEN generic, which derives to
      // `generic-function-set` -- a choice tag, not a callable -- while the
      // slot derives to `function-value-dispatch`. No conversion exists
      // between the two and none can: a set index is not a frame. The two
      // authorities disagree and the slot is the one that is right, because it
      // states the instantiation and the name states none.
      //
      // Reading the contextual signature here is the SAME question
      // `specialization.ts`'s `fromValueUse` already asks at this same node to
      // mint the copy (its "contextual type is a closed signature" branch), so
      // the copy this type names exists by construction rather than by
      // coincidence. Only a contextual type with exactly one call signature
      // and no type parameters of its own qualifies: a generic contextual type
      // (`const nodeVisitor: NodeVisitor = visitNode`) is a set the value stays
      // open in, and an overload set states no single frame.
      name: 'generic-function-value-at-stated-instantiation',
      forms: [ts.SyntaxKind.Identifier],
      resolve: (node) => {
        if (!ts.isIdentifier(node) || !ts.isExpression(node)) return null
        const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0]
        if (!declaration || !genericSourceFunctionDeclarationOf(declaration)) return null
        const contextual = checker.getContextualType(node)
        const signatures = contextual?.getCallSignatures() ?? []
        const only = signatures.length === 1 ? signatures[0] : undefined
        if (!contextual || !only || (only.getTypeParameters()?.length ?? 0) > 0) return null
        if (contextual.getConstructSignatures().length > 0) return null
        return typeOf(contextual)
      }
    },
    {
      // A binding pattern's type IS its source's: the pattern is the reference
      // half of `bind(reference, value)` and holds nothing of its own. The
      // checker types the pattern node from its own shape instead (a `[]`
      // initializer contextually typed by the pattern becomes the empty TUPLE
      // at the pattern while the literal itself is an array).
      name: 'binding-pattern-is-its-source',
      forms: [ts.SyntaxKind.ArrayBindingPattern, ts.SyntaxKind.ObjectBindingPattern],
      resolve: (node) => {
        // Re-tested rather than left to `forms`: a rule must answer correctly
        // for ANY node it is handed. `forms` is a claim the dispatcher can act
        // on and the audit can check, never the thing that makes a rule right
        // -- and this rule proved why. It was the first one ported, its kind
        // test was lifted into `forms` instead of kept, and it then answered
        // for call expressions, identifiers and string literals the moment
        // `GEA_STRUCTURAL_FORM_AUDIT` asked it outside its declared forms.
        if (!ts.isArrayBindingPattern(node) && !ts.isObjectBindingPattern(node)) return null
        const parent = node.parent
        if (ts.isVariableDeclaration(parent) && parent.initializer) return patternSourceTypeAt(parent.initializer)
        if (ts.isParameter(parent) || ts.isBindingElement(parent)) return mapper.typeAt(parent)
        return null
      }
    },
    {
      // `Function.prototype.bind`, read as the callee of its own call. The
      // ambient declaration is FIVE overloads -- one per bound-argument arity --
      // and a value cannot be five conventions, so interning the read's own type
      // published `unresolved(no primitive joining 2 overload signatures into
      // one calling convention)` and killed every `host.readFile.bind(host)` in
      // the program (tsc's `program.ts`, `maybeBind`). TypeScript has already
      // chosen one overload at this site -- the argument count and the source's
      // own `this` type decide it -- so the read is that one signature, asked
      // for at the call the read is the callee of and nowhere else.
      //
      // `.call`/`.apply` need no such rule: each is declared once, and a borrow
      // through them is rewritten at the call anyway
      // (`ir/lower-invocation.ts`'s `deferredExplicitThisCalleeOf`).
      //
      // Asked EARLY: an optional link (`host.realpath?.bind`) is a union of the
      // overload set with the absence, and the local-union resolver above would
      // otherwise publish that union -- overload set included -- before this
      // rule was ever reached. The absence itself is kept, since the read really
      // can produce none.
      name: 'builtin-bind-signature',
      forms: [ts.SyntaxKind.PropertyAccessExpression],
      resolve: (node) => {
        const boundBuiltin = builtinBindSignatureAt(node)
        if (boundBuiltin) {
          // The overload's result is the bound callable, receiver-less -- the
          // same answer the call node gives below, so the invocation producer
          // sees one return type from both.
          const signature = signatureOf(boundBuiltin)
          const bound = table.intern({
            kind: 'signature',
            call: [{ ...signature, result: withoutReceiver(signature.result) }],
            construct: []
          })
          const own = checker.getTypeAtLocation(node)
          const absences = (own.isUnion() ? own.types : []).filter(
            (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0
          )
          return absences.length === 0 ? bound : table.intern({ kind: 'union', members: [bound, ...absences.map(typeOf)] })
        }
        return null
      }
    },
    {
      // The bound function `host.readFile.bind(host)` PRODUCES: the checker
      // types it `OmitThisParameter<T>`, which for a method is `T` itself, and
      // `T`'s signature still names the method's implicit receiver
      // (`structural-receiver.ts`). The bound callable has none -- `bind` fixed
      // it -- so a value read out of this call must state a receiver-less
      // convention, or every slot it enters would be asked to bind the receiver
      // a second time. The absence of an optional link is kept as above.
      name: 'bound-call-result',
      forms: [ts.SyntaxKind.CallExpression, ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const bound = boundCallResultAt(node) ?? boundCellResultAt(node)
        if (bound !== null) return bound
        return null
      }
    },
    {
      name: 'prototype-object-local',
      forms: [ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const prototypeLocal = prototypeObjectLocalTypeAt(node)
        if (prototypeLocal) return prototypeLocal
        return null
      }
    },
    {
      name: 'array-pattern-rest',
      // The identifier arm resolves a SYMBOL to its declaration, so what that
      // declaration turns out to be does not widen the domain: the node asked
      // about is still only ever the element or a name for it.
      forms: [ts.SyntaxKind.BindingElement, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const restArray = arrayPatternRestTypeAt(node)
        if (restArray) return restArray
        return null
      }
    },
    {
      name: 'rest-assignment-array-shape',
      forms: [ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const restAssignmentArray = restAssignmentArrayShapeAt(node)
        if (restAssignmentArray) return restAssignmentArray
        return null
      }
    },
    {
      name: 'local-union',
      forms: [ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const localUnion = localUnionAt(node)
        if (localUnion) return localUnion
        return null
      }
    },
    {
      name: 'implicit-arguments-object',
      forms: [ts.SyntaxKind.Identifier],
      resolve: (node) => {
        if (!isArgumentsObjectIdentifier(node, checker)) return null
        const owner = enclosingArgumentsFunction(node)
        const signature = owner ? checker.getSignatureFromDeclaration(owner) : undefined
        const slot = signature ? implicitArgumentsSlotOf(signature) : null
        if (!signature || !slot) return null
        // The ABI and arguments allocation already use this signature's sealed
        // phantom slot. Publish that same carrier at the expression, so indexed
        // reads do not recover their element from lib.d.ts's erased IArguments.
        const frame = table.get(mapper.resolvedSignatureTypeOf(signature, 'call')).shape
        return frame.kind === 'signature' ? (frame.call[0]?.parameters[slot.ordinal]?.type ?? null) : null
      }
    },
    {
      // `Array.isArray(x) ? x[0] : x` where nothing in `x` is assignable to
      // the predicate's `any[]`: TypeScript narrows `x` to `T & any[]` rather
      // than to `never`, and types the read `any`. That `any` is the failed
      // narrowing's artifact, not a boundary the program declared -- see
      // `arrayPredicateNarrowedTypeOf`. Asked BEFORE the array read below,
      // because the receiver is still that intersection and the carrier it
      // interns is not the one the read should be resolved through.
      name: 'array-predicate-narrowed-element',
      forms: [ts.SyntaxKind.ElementAccessExpression],
      resolve: (node) => {
        if (!ts.isElementAccessExpression(node)) return null
        const element = arrayPredicateNarrowedElementTypeOf(checker, node)
        return element === null ? null : typeOf(element)
      }
    },
    {
      name: 'structural-array-read',
      forms: [ts.SyntaxKind.ElementAccessExpression],
      resolve: (node) => {
        const censusedArrayElement = ts.isElementAccessExpression(node)
          ? inferredArrayElementAt(checker, collections, layoutTypeAt, node.expression)
          : null
        // Read through the receiver's actual structural carrier whenever the
        // checker left the indexed result unstated. A parameter census was the
        // first place this mattered, but it is not the only place: an evolving
        // local `const values = []` is deliberately corrected below to
        // `array<any>` when no write census can prove a narrower element, while
        // `values[i]` can still be reported as `never` at an earlier flow point.
        // Taking the result from that stale checker view gives one cell two
        // answers -- an array that physically stores values and an indexed read
        // with no carrier. The receiver is a child of the access, so resolving it
        // here strictly descends the AST and cannot recurse back to this node.
        const arrayReadSource = ts.isElementAccessExpression(node)
          ? censusedArrayElement
            ? table.intern({ kind: 'array', element: typeOf(censusedArrayElement), readonly: false, extension: [] })
            : (localUnionAt(node.expression) ?? mapper.typeAt(node.expression))
          : null
        const arrayRead = structuralArrayReadAt(checker, table, arrayReadSource, node)
        if (arrayRead) return arrayRead
        return null
      }
    },
    {
      // A recovered dynamic receiver makes the checker's downstream `never`
      // stale as well. This occurs one link after an evolving-array repair:
      // the checker typed `values[i]` as `never`, so it also typed
      // `values[i].field` as `never`; the mapper has since established that
      // the indexed value is `any`, whose property result is necessarily the
      // same dynamic boundary. Follow only that exact bottom-vs-any mismatch.
      // A genuinely `never` receiver and every statically shaped receiver keep
      // their own property type.
      name: 'never-property-of-any-receiver',
      forms: [ts.SyntaxKind.PropertyAccessExpression],
      resolve: (node) => {
        if (ts.isPropertyAccessExpression(node) && (absentSubstitutedTypeAt(node).flags & ts.TypeFlags.Never) !== 0) {
          const receiver = mapper.typeAt(node.expression)
          const receiverShape = table.get(receiver).shape
          if (receiverShape.kind === 'primitive' && receiverShape.primitive === 'any') return receiver
        }
        return null
      }
    },
    {
      name: 'prototype-object',
      // The union of the three resolvers this rule ORs: two answer for a
      // property access, the third for a parameter or a name of one.
      forms: [ts.SyntaxKind.PropertyAccessExpression, ts.SyntaxKind.Parameter, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const prototypeObject = prototypeObjectTypeAt(node) ?? prototypeObjectParameterTypeAt(node) ?? prototypeObjectMemberTypeAt(node)
        if (prototypeObject) return prototypeObject
        return null
      }
    },
    {
      name: 'evolving-array-member',
      forms: [ts.SyntaxKind.PropertyAccessExpression],
      resolve: (node) => {
        const evolvingArrayMember = evolvingArrayMemberTypeAt(node)
        if (evolvingArrayMember) return evolvingArrayMember
        return null
      }
    },
    {
      name: 'census-member-signature',
      forms: [ts.SyntaxKind.PropertyAccessExpression],
      resolve: (node) => {
        const censusMemberSignature = censusMemberSignatureAt(node)
        if (censusMemberSignature) return censusMemberSignature
        return null
      }
    },
    {
      name: 'call-result',
      forms: [ts.SyntaxKind.CallExpression],
      resolve: (node) => {
        const callResult = callResultAt(node)
        if (callResult) return callResult
        return null
      }
    },
    {
      // The generator half of `physical-overload` below, asked at the CALL
      // rather than at a binding: the callee already publishes the one
      // convention its implementation has, and this is the same fact on the
      // result side. See `physicalGeneratorOverloadResultAt`.
      name: 'physical-generator-overload-result',
      forms: [ts.SyntaxKind.CallExpression],
      resolve: (node) => {
        const physicalResult = physicalGeneratorOverloadResultAt(checker, node)
        if (physicalResult) return typeOf(physicalResult)
        return null
      }
    },
    {
      name: 'constructor-choice-result',
      forms: [ts.SyntaxKind.NewExpression],
      resolve: constructResultAt
    },
    {
      name: 'object-descriptor-return',
      forms: [ts.SyntaxKind.CallExpression],
      resolve: (node) => {
        const descriptorReturn = objectDescriptorReturnTypeAt(node)
        if (descriptorReturn) return descriptorReturn
        return null
      }
    },
    {
      // A parenthesized expression is its operand: the language attaches no
      // type of its own to the parentheses (`(cache = new Map())` inside a `||`
      // is the assignment, and the assignment's value is the allocation this
      // mapper laid out from its context). Asking the checker at the
      // parentheses instead hands back its own, pre-contextual reading of the
      // inside -- `Map<any, any>` -- and the merge that cites this node then
      // publishes a value nobody allocates.
      name: 'parenthesized-is-its-operand',
      forms: [ts.SyntaxKind.ParenthesizedExpression],
      resolve: (node) => (ts.isParenthesizedExpression(node) ? mapper.typeAt(node.expression) : null)
    },
    {
      // Likewise a plain assignment is the value it assigns (`AssignmentExpression
      // : LeftHandSideExpression = AssignmentExpression` completes with the RHS
      // value after PutValue) -- the rule `producers/computations.ts`'s
      // `finishComputation` already applies to the assignment OPERATION's own
      // result, asked here for the node so a merge citing `(cache = new Map())`
      // sees the same value the operation publishes.
      name: 'assignment-is-its-right-hand-side',
      forms: [ts.SyntaxKind.BinaryExpression],
      resolve: (node) =>
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? mapper.typeAt(node.right) : null
    },
    {
      // A read off a type guard's narrowed family view publishes the FAMILY's
      // field, not the guard's restatement of it. `node.arguments` after
      // `isRequireCall(node)` is `NodeArray<Expression> & [StringLiteralLike]`
      // to the checker -- an intersection member's property is the
      // intersection of the members' properties -- and `NodeArray<Expression>`
      // in the one object the family lays out (`familyMemberNarrowedBy`). The
      // guard restated what the field holds; the storage the read loads from
      // is the family's, and the array-and-tuple intersection is a shape no
      // carrier spells (its overload sets never join).
      name: 'narrowed-family-property',
      forms: [ts.SyntaxKind.PropertyAccessExpression],
      resolve: (node) => {
        if (ts.isPropertyAccessExpression(node)) {
          const receiver = checker.getTypeAtLocation(node.expression)
          const narrowedMember = receiver.isIntersection() ? narrowedFamilyMemberOf(receiver) : null
          const property = narrowedMember ? checker.getPropertyOfType(narrowedMember, node.name.text) : undefined
          if (property) return typeOf(checker.getTypeOfSymbolAtLocation(property, node))
        }
        return null
      }
    },
    {
      // Compiler-minted records can refine an ambient any/unknown member (for
      // example PropertyDescriptor.value). A concrete checker read is already
      // flow-sensitive: replacing it with the field's storage type would widen
      // `number | Wrapped` back after a typeof guard. Storage and a narrowed
      // read are different questions; preserve the checker's concrete answer.
      name: 'dynamic-property-of-shaped-receiver',
      forms: [ts.SyntaxKind.PropertyAccessExpression],
      resolve: (node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          (checker.getTypeAtLocation(node).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
        ) {
          const receiverType = mapper.typeAt(node.expression)
          const receiverShape = table.get(receiverType).shape
          const presentShapes =
            receiverShape.kind === 'union'
              ? receiverShape.members
                  .map((member) => table.get(member).shape)
                  .filter((shape) => !(shape.kind === 'primitive' && (shape.primitive === 'undefined' || shape.primitive === 'null')))
              : [receiverShape]
          // A nullable record has one present shape. A choice of records does
          // not: choosing its first object would discard the other arms' fields.
          const objectShape = presentShapes.length === 1 ? presentShapes[0] : null
          if (objectShape?.kind === 'object' && !objectShape.membersDropped) {
            const field = objectShape.members.find((member) => member.key.kind === 'string' && member.key.value === node.name.text)
            if (field) return field.type
          }
        }
        return null
      }
    },
    {
      // A name in callee position whose call instantiates a generic is typed by
      // the copy that call reaches, not by the generic it was written against:
      // the identifier `identity` in `identity(1)` holds `(value: number) =>
      // number`, and holding the unbound `<T>(value: T) => T` there is the hole
      // monomorphization removes. The checker performed exactly this
      // substitution to type-check the call; this reads its answer back through
      // the copy's own view rather than redoing the inference.
      // A callee names its call's site; a generic function named as a VALUE
      // (`binarySearch(array, insert, identity, compare)`, `emitNodeList(emit,
      // ...)`) names its own -- `specialization.ts`'s `fromValueUse` keys the
      // copy that value is on the reference itself, and reading the name
      // through that copy's view is what closes its parameters: the checker's
      // instantiation where it made one, the constraints where it did not.
      // The value-use site is keyed on the REFERENCE, whatever its parent is:
      // an argument's parent is the call it is passed to, but a parameter
      // default's is the parameter (`nodeVisitor: NodeVisitor = visitNode`,
      // TypeScript's `visitEachChild`) and a property's is the assignment, and
      // none of those parents is a site of its own. So the parent is asked
      // only where it names the reference as its callee, and the reference
      // itself is asked whenever the parent answered nothing.
      name: 'specialization-copy',
      // The one rule 4.3 could not key, and the reason is a finding rather than
      // an omission: `namesItsSite` returns true by DEFAULT -- for every node
      // whose parent is not a call, new, tagged template or JSX opening element
      // -- so this rule asks about `node.parent` for arbitrary children of an
      // arrow function, a function expression, a type reference or an
      // `extends` clause. An arrow's concise body is any expression at all, so
      // the domain is not a closed set of forms; it is "almost everything",
      // which `forms: null` states honestly. Keying it means narrowing
      // `namesItsSite` to the positions that really name a site, which is a
      // change to what the rule ANSWERS and so not part of this port.
      forms: null,
      resolve: (node) => {
        const site =
          (namesItsSite(node) ? specializations.specializationAt(node.parent, substituteTypeParameter) : null) ??
          // A namespace-qualified name is the reference itself, exactly as an
          // identifier is -- `specialization.ts`'s `valueUseSubjectOf` keys the
          // value-use site on the whole `State.enter` access, because that is
          // what denotes the declaration (`namespace-paths.ts`). Asking for any
          // other property access costs nothing: only a node the census
          // recorded a site on answers, and a plain property read never is one.
          (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
            ? specializations.specializationAt(node, substituteTypeParameter)
            : null)
        if (site) {
          const copy = mapperFor(copyPathOf(site))
          // The synthesized-union check of the non-specialized path below.
          const specializedUnionArms = parameters.unionArmsAt(node)
          if (specializedUnionArms) return table.intern({ kind: 'union', members: specializedUnionArms.map((arm) => copy.typeOf(arm)) })
          return copy.typeOf(absentSubstitutedTypeAt(node))
        }
        return null
      }
    },
    {
      // The same absent-TYPE substitution the union arm above performs, at the
      // one other place a type enters from a source position: a binding whose
      // whole declared type is an absent host class, rather than one arm of a
      // union of them.
      name: 'array-literal-implied-pattern',
      forms: [ts.SyntaxKind.ArrayLiteralExpression],
      resolve: (node) => (ts.isArrayLiteralExpression(node) ? impliedPatternArrayLiteralType(node) : null)
    },
    {
      name: 'inferred-array-element',
      forms: [
        ts.SyntaxKind.ArrayLiteralExpression,
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.Identifier,
        ts.SyntaxKind.PropertyAccessExpression
      ],
      resolve: (node) => {
        const inferredElement = inferredArrayElementAt(checker, collections, layoutTypeAt, node)
        if (inferredElement) return table.intern({ kind: 'array', element: typeOf(inferredElement), readonly: false, extension: [] })
        return null
      }
    },
    {
      // See `unstatedNeverArray` for why `never` is the wrong answer for an
      // array whose element nothing states, and the box the right one.
      name: 'unstated-never-array',
      forms: [
        ts.SyntaxKind.ArrayLiteralExpression,
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.Identifier,
        ts.SyntaxKind.PropertyAccessExpression,
        // A parameter is here for ONE case: it is an alias of an array whose
        // component the collection census refused, so it must carry the same
        // boxed element the caller's cell does. See `unstatedNeverArray`.
        ts.SyntaxKind.Parameter
      ],
      resolve: (node) => {
        if (unstatedNeverArray(checker, collections, layoutTypeAt, node)) {
          return table.intern({
            kind: 'array',
            element: table.intern({ kind: 'primitive', primitive: 'any' }),
            readonly: false,
            extension: []
          })
        }
        return null
      }
    },
    {
      // The K/(V) a bare `new Map()`/`new Set()`/`new WeakMap()`/`new
      // WeakSet()` never states -- `collection-bindings.ts` has bound it since
      // its creation, and nothing downstream ever asked until now. See
      // `inferredCollectionTypeArgumentsAt`'s own header, in this file's
      // `structural-array-element.ts` sibling.
      //
      // Asked BEFORE the bag census, not after, because the two answer the
      // same node about the same storage and the collection census is the one
      // that looked at this cell's own uses. `WebGLRenderer.js`'s `let
      // programs = materialProperties.programs` is the shape: `programs` is a
      // slot of the `WebGLProperties` bag, so `bagShapeTypeAt` answers first
      // with the slot's own type -- `Map<any, any> | undefined`, the checker's
      // reading of the `new Map()` stored into it -- and the declaration kept
      // `optional(keyed-collection(map, dynamic, dynamic))` while every read
      // past the `if ( programs === undefined )` guard carried the census's
      // `keyed-collection(map, string, dynamic)`. Two authorities over one
      // cell, surfacing as an unsatisfiable `binding-read-conversion` per
      // read. Neither census is wrong about what it looked at; the collection
      // census simply looked at more (`programs.set( programCacheKey, ... )`
      // says what K is, the stored value's type does not), so it goes first.
      // It answers for a far narrower set of nodes than the bag census does --
      // only where a collection was actually bound for this exact owner,
      // allocation or read -- so this does not take work away from bags
      // generally, only where both describe one storage.
      name: 'inferred-collection-type-arguments',
      // Every one of these five is also a form `bag-shape` serves, which is what
      // makes the collection-before-bag order above load-bearing rather than
      // incidental: on exactly these kinds both rules can answer for one node.
      // The prose said so; the two form lists now make it checkable.
      forms: [
        ts.SyntaxKind.NewExpression,
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.Identifier,
        ts.SyntaxKind.PropertyAccessExpression
      ],
      resolve: (node) => {
        const inferredCollection = inferredCollectionTypeArgumentsAt(collections, table, typeOf, bags, layoutTypeAt(node), node)
        if (inferredCollection) return inferredCollection
        return null
      }
    },
    {
      // The position's own statement, where the census had no writes to read
      // and the allocation itself states nothing -- and the syntax that carries
      // that allocation, unchanged, to the call the checker resolved off its
      // own dynamic reading. See `statedCollectionTypeAt`.
      name: 'stated-collection',
      forms: [
        ts.SyntaxKind.NewExpression,
        ts.SyntaxKind.ParenthesizedExpression,
        ts.SyntaxKind.BinaryExpression,
        ts.SyntaxKind.CallExpression
      ],
      resolve: (node) => {
        const statedCollection = statedCollectionTypeAt(checker, node)
        if (statedCollection) return typeOf(statedCollection)
        return null
      }
    },
    {
      // The same statement for `new Array(n)`, whose ambient overload is
      // `any[]` for the identical reason a bare `new Map()` is `Map<any,
      // any>`. See `contextualArrayConstructTypeAt`. An assignment carries it
      // to the cell's merge through `assignment-is-its-right-hand-side`, so
      // only the allocation itself needs a form here.
      name: 'contextual-array-construct',
      forms: [ts.SyntaxKind.NewExpression],
      resolve: (node) => {
        const contextualArray = contextualArrayConstructTypeAt(checker, node)
        if (contextualArray) return typeOf(contextualArray)
        return null
      }
    },
    {
      // The receiver's own type is not enough: `Map`/`WeakMap`'s `get` is a
      // prototype call, and a prototype call's result comes from the callee's
      // SIGNATURE -- which the checker instantiates from the receiver
      // EXPRESSION's type, not from what this compiler selected for it. See
      // `collectionMemberResultTypeAt` (`structural-array-element.ts`).
      name: 'collection-member-result',
      forms: [ts.SyntaxKind.CallExpression],
      resolve: (node) => {
        const collectionMember = collectionMemberResultTypeAt(collections, table, typeOf, bags, layoutTypeAt, node)
        if (collectionMember) return collectionMember
        return null
      }
    },
    {
      name: 'bag-shape',
      // A JS field written `this.field = {}` in a constructor makes the ASSIGNMENT
      // the field symbol's declaration as far as the checker is concerned, which
      // is why an `=` BinaryExpression is an owner form here and not only a
      // VariableDeclaration.
      forms: [
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.Parameter,
        ts.SyntaxKind.BinaryExpression,
        ts.SyntaxKind.CallExpression,
        ts.SyntaxKind.NewExpression,
        ts.SyntaxKind.Identifier,
        ts.SyntaxKind.PropertyAccessExpression,
        ts.SyntaxKind.ElementAccessExpression,
        ts.SyntaxKind.ObjectLiteralExpression
      ],
      resolve: (node) => {
        const inferredBag = bagShapeTypeAt(table, typeOf, bags, node)
        if (inferredBag) return inferredBag
        return null
      }
    },
    {
      name: 'rest-parameter-array-element',
      forms: [ts.SyntaxKind.Parameter, ts.SyntaxKind.Identifier],
      resolve: (node) => {
        // Real call-site evidence (`parameter-bindings.ts`'s `restElementTypeAt`,
        // joined over every reachable caller's actual arguments) outranks the
        // checker's own contextual-tuple widening -- the same priority an
        // ordinary parameter's census answer already has over a bare checker
        // guess. `structural-parts.ts`'s `parameterOf` asks the identical
        // question the identical way, so the ABI and this body-side reference
        // to the same parameter cannot disagree about which one answered.
        // In `parameterOf`'s own order: census evidence, then a union of
        // tuples collapsed to one element, then the unannotated-tuple widening.
        const restElement =
          censusRestElementAt(checker, identities, parameters, node) ??
          restParameterUnionOfTuplesElementAt(checker, identities, node) ??
          restParameterArrayElementAt(checker, identities, node)
        if (restElement) return table.intern({ kind: 'array', element: typeOf(restElement), readonly: false, extension: [] })
        return null
      }
    },
    {
      name: 'implied-pattern-array-element',
      // NOT ObjectBindingPattern, though `impliedPatternParameterOf` admits one:
      // the pattern it finds IS this node, and the caller then requires the
      // parameter's name to be an ARRAY pattern, so an object pattern can never
      // reach a non-null answer here.
      forms: [ts.SyntaxKind.Parameter, ts.SyntaxKind.ArrayBindingPattern],
      resolve: (node) => {
        const impliedElement = impliedPatternArrayElementAt(checker, parameters, node)
        if (impliedElement) return table.intern({ kind: 'array', element: typeOf(impliedElement), readonly: false, extension: [] })
        return null
      }
    },
    {
      // A name bound to ONE function but annotated with an overloaded type.
      // `physicalOverloadTypeAt` states the rule; asked here, at the binding,
      // because the allocation already answers it from the initializer and the
      // two must not disagree about how many conventions one value has.
      name: 'physical-overload',
      forms: [
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.PropertyAssignment,
        ts.SyntaxKind.ImportSpecifier,
        ts.SyntaxKind.ExportSpecifier,
        ts.SyntaxKind.ImportClause,
        ts.SyntaxKind.Identifier
      ],
      resolve: (node) => {
        const physical = physicalOverloadTypeAt(checker, node, parameters)
        if (physical) return typeOf(physical)
        return null
      }
    },
    {
      // `new String(x) as T` -- the same shape one type-object over. See `physicalStringObjectTypeAt`.
      name: 'physical-string-object',
      forms: [
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.PropertyAssignment,
        ts.SyntaxKind.Identifier
      ],
      resolve: (node) => {
        const stringObjectPhysical = physicalStringObjectTypeAt(checker, node, parameters)
        if (stringObjectPhysical) return typeOf(stringObjectPhysical)
        return null
      }
    },
    {
      // The checker's constraint erasure over this copy's own binding. Guarded
      // on the substitution actually resolving: a generic whose copy binds
      // nothing has no better answer than the constraint, and answering with a
      // naked parameter there would trade a wide carrier for no carrier.
      name: 'constraint-erased-parameter',
      forms: [ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const erased = constraintErasedParameterAt(checker, node)
        if (erased !== null && substituteTypeParameter(erased) !== erased) return typeOf(erased)
        return null
      }
    },
    {
      // A disagreement the census resolved to a SYNTHESIZED union.
      // `unionArmsAt`'s own comment says why this is not a `ts.Type`
      // (`getUnionType` is not public); the structural union is built at
      // the one place `table.intern` and this copy's `typeOf` are both in
      // scope, where the plain `bound` fallback would have found nothing
      // and fallen through to `any`.
      name: 'parameter-union-arms',
      // The union of four composed censuses -- parameter, return, local, field --
      // each of which owns a different slice of this list.
      forms: [
        ts.SyntaxKind.Parameter,
        ts.SyntaxKind.Identifier,
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.PropertyDeclaration,
        ts.SyntaxKind.PropertyAccessExpression,
        ts.SyntaxKind.FunctionDeclaration,
        ts.SyntaxKind.FunctionExpression,
        ts.SyntaxKind.ArrowFunction,
        ts.SyntaxKind.MethodDeclaration,
        ts.SyntaxKind.GetAccessor,
        ts.SyntaxKind.CallExpression,
        ts.SyntaxKind.NewExpression
      ],
      resolve: (node) => {
        const unionArms = parameters.unionArmsAt(node)
        if (unionArms) return table.intern({ kind: 'union', members: unionArms.map((arm) => typeOf(arm)) })
        return null
      }
    },
    {
      name: 'dynamic-object-boundary',
      forms: [ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const dynamicObjectBoundary = dynamicObjectBoundaryAt(node)
        if (dynamicObjectBoundary) return typeOf(dynamicObjectBoundary)
        return null
      }
    },
    {
      name: 'unplaced-hoisted-read',
      forms: [ts.SyntaxKind.Identifier],
      resolve: (node) => {
        const unplacedHoistedRead = unplacedHoistedReadAt(node)
        if (unplacedHoistedRead) return typeOf(unplacedHoistedRead)
        return null
      }
    }
  ]

  const preparedRules = prepareStructuralRules(structuralRules)
  // Decided once per mapper, never per node: `typeAt` is asked for essentially
  // every node in the program, and reading an environment variable there would
  // make the instrument's own cost the thing it measures.
  const recordDisagreement = structuralDisagreementsEnabled()
    ? (disagreement: StructuralDisagreement) => {
        disagreements.push(disagreement)
      }
    : undefined

  const typeAt = (node: ts.Node): StructuralTypeId =>
    preparedRules.resolve(node, recordDisagreement) ?? typeOf(absentSubstitutedTypeAt(node))
  const rawTypeAt = (node: ts.Node): ts.Type => {
    // A binding pattern is the reference half of binding its source and has no
    // independent value type. TypeScript does not support every direct
    // `getTypeAtLocation` query on these pattern nodes, so expose the same raw
    // source type that `typeAt` above interns.
    if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) {
      const parent = node.parent
      if (ts.isVariableDeclaration(parent) && parent.initializer) return rawTypeAt(parent.initializer)
      if (ts.isParameter(parent) || ts.isBindingElement(parent)) return rawTypeAt(parent)
    }
    return absentSubstitutedTypeAt(node)
  }
  const mapper: StructuralMapper = {
    forSpecialization: mapperFor,
    substituteTypeParameter,
    typeOf,
    typeAt,
    mutableMethodStorageTypeAt: mutableMethods.storageTypeAt,
    mutableMethodReadTypeAt: mutableMethods.readTypeAt,
    boundCallResultAt,
    constructResultAt,
    evolvingArrayMemberTypeAt,
    objectDescriptorReturnTypeAt,
    instanceTypeAt: (node) => {
      if (!ts.isClassExpression(node)) return typeAt(node)
      const construct = checker.getTypeAtLocation(node).getConstructSignatures()[0]
      return construct ? typeOf(construct.getReturnType()) : typeAt(node)
    },
    valueTypeAt: (node) => {
      const localUnion = localUnionAt(node)
      if (localUnion) return localUnion
      const accessor = accessorSignatureOf(checker, node)
      if (accessor) return table.intern({ kind: 'signature', call: [signatureOf(accessor)], construct: [] })
      // An overload set's implementation declares the one signature that
      // physically exists -- see `implementationSignatureOf`. Asked before the
      // symbol-level answer below, which is every overload and no single
      // convention.
      const implementation = implementationSignatureOf(checker, node)
      if (implementation) return table.intern({ kind: 'signature', call: [signatureOf(implementation)], construct: [] })
      // A `?`-marked method WITH A BODY allocates its function object
      // unconditionally -- see `optionalMethodSignatureOf`. Asked before the
      // symbol-level answer below, which is `T | undefined` for an optional
      // member whether read through the symbol or the node, and states a
      // fact about READING the member, never about whether this declaration's
      // own allocation runs.
      const optionalMethod = optionalMethodSignatureOf(checker, node)
      if (optionalMethod) return table.intern({ kind: 'signature', call: [signatureOf(optionalMethod)], construct: [] })
      // A return census answers the RESULT of a callable declaration, never
      // the value allocated for the declaration itself. `layoutTypeAt` reads
      // that census for ordinary nodes, so asking it directly of an arrow or
      // function expression whose stated upper bound was refined returns the
      // concrete result type (an Array for `(): Iterable<T> => [...]`) and
      // would publish an Array allocation where the source allocates a
      // function. Rebuild the callable shape from its own signature here;
      // `signatureOf` consults the same composed census for the result slot,
      // preserving both facts without letting one replace the other.
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        (parameters.typeAt(node) !== null || parameters.unionArmsAt(node) !== null)
      ) {
        const signature = checker.getSignatureFromDeclaration(node)
        if (signature) return table.intern({ kind: 'signature', call: [signatureOf(signature)], construct: [] })
      }
      const declared = declaredValueTypeOf(checker, node)
      if (declared) {
        // A binding ANNOTATED with an overloaded type but INITIALIZED with one
        // function has exactly one physical convention -- the initializer's.
        // `structural-parts.ts`'s `memberOf` already asks this for a member;
        // a module-level `const` is the same fact spelled at file scope, and
        // hono's `export const parseBody: ParseBody = async (...)` is the
        // case that showed the two answers apart.
        return typeOf(physicalInitializerTypeOf(checker, node, declared, parameters) ?? declared)
      }
      const layout = layoutTypeAt(node)
      // A function LITERAL contextually typed by an overload set. Only a
      // `function` declaration merges into several conventions; an arrow or a
      // function expression is one function with one signature, whatever the
      // position expecting it declares -- so the literal's own signature is
      // the answer, exactly as `implementationSignatureOf` above answers the
      // merged-declaration spelling of the same fact.
      //
      // The overload set is not always written as one. `[].map` over a UNION
      // of two array types resolves to a callback parameter that is the
      // INTERSECTION of the two arms' callbacks -- contravariance -- and an
      // intersection of callables is exactly an overload set. hono's
      // `this.#matchResult[0].map(([[, route]]) => route)` (`request.ts:421`)
      // is that, and the arrow written there has one parameter list.
      //
      // Gated on the layout actually carrying more than one signature, so an
      // ordinary arrow keeps resolving through `layoutTypeAt` untouched.
      if (
        process.env.GEA_DEBUG_VALUETYPE &&
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        node.getText().includes(process.env.GEA_DEBUG_VALUETYPE)
      ) {
        console.error('[DEBUG valueTypeAt]', node.getText().slice(0, 80))
        console.error('  declared(before):', declared)
        console.error('  layout sig count:', layout.getCallSignatures().length)
        console.error('  layout typeToString:', checker.typeToString(layout))
        const own = checker.getSignatureFromDeclaration(node)
        console.error('  own signature exists:', !!own)
        if (own) {
          for (const p of own.getParameters()) {
            const t = checker.getTypeOfSymbolAtLocation(p, node)
            console.error(
              '    param',
              p.getName(),
              checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation),
              'isTuple:',
              checker.isTupleType(t)
            )
          }
        }
      }
      // TRIED AND MEASURED DEAD (2026-09-03): widening this `> 1` gate to
      // also fire on an unannotated trailing rest -- hono's `newResponse:
      // NewResponse = (...args) => ...`, whose `layout` here is ONE
      // TypeScript-joined signature (`args_0: any, args_1?: any, args_2?:
      // unknown`), the checker's own collapse of a bare-rest literal against
      // several overloads, done before this function runs. Preferring `own`
      // there is a no-op: isolated A/B (snapshot, hono-hello + the three.js app)
      // byte-identical -- `own`'s contextual type for the rest
      // parameter is EQUALLY `any`/`unknown`-degraded by that same join, so
      // `own`/`layout` are two views of one already-lossy checker answer,
      // not two to disagree between. Also checked: the call-site census
      // (`StructuralPartsInput.parameters`) never binds a rest parameter's
      // declaration either (`bound` null for every `...args` in hono,
      // confirmed directly). The richer per-position record `abiBlockers`
      // reports seeing comes from neither path -- likely the `args as
      // Parameters<NewResponse>` cast at its one use site, narrowing a
      // DIFFERENT operand. Separate work; do not retry this selection point.
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && layout.getCallSignatures().length > 1) {
        const own = checker.getSignatureFromDeclaration(node)
        if (own) return table.intern({ kind: 'signature', call: [signatureOf(own)], construct: [] })
      }
      return typeOf(layout)
    },
    resolvedSignatureTypeOf: (signature, kind, resultOverride) =>
      table.intern({
        kind: 'signature',
        call: kind === 'call' ? [signatureOf(signature, resultOverride)] : [],
        construct: kind === 'construct' ? [signatureOf(signature, resultOverride)] : []
      }),
    rawTypeAt,
    patternReadTypeAt: (element) => parameters.patternReadTypeAt?.(element) ?? null,
    structuralDisagreements: disagreements,
    structuralFormViolations: preparedRules.formViolations,
    classCopies: () =>
      new Map([...classCopyKeys].map(([root, copies]) => [root, [...copies.values()].sort((a, b) => a.ordinal - b.ordinal)]))
  }
  return mapper
}
