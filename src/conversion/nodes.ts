import type { DeclarationId } from '../identity/ids.js'
import type { Representation, TaggedUnionArm } from '../representation/model.js'
import { isOpenDocument, representationKey, standInRefuses } from '../representation/model.js'
import type { ConversionCapability, ConversionNode, ConversionNodeId } from './algebra.js'
import { transfersNativeStorage, validateCapability } from './algebra.js'
import { recipeClosureOf, recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { createConversionDerivationContext, deriveConversionCapability } from './derive.js'
import { narrowingCapabilityFor } from './build.js'
import type { CoercionOperation, ConversionRuntimeRegistry } from './registry.js'
import type { FamilyMemberKeys } from './record-view.js'
import { impossibleFieldReadOf, IMPOSSIBLE_FIELD_READ } from './impossible-field-read.js'
import { nativeUnboundMethodContractOf, NATIVE_UNBOUND_METHOD_MATERIALIZER } from './native-method.js'
import { nativeBufferUnboundMethodContractOf } from './native-buffer-method.js'
import { siblingClassArgumentOf, SIBLING_CLASS_ARGUMENT } from './sibling-class.js'
import { structuralRecipeRequiredFor } from './structural-plan.js'
import { promiseAdoptionPlanOf } from './promise-adoption.js'
import { CHECKED_NATIVE_FIELD_READ, checkedNativeFieldReadMismatchOf } from './checked-native-field-read.js'
import { nativeObjectSamplePlanOf } from './native-object-sample.js'
import { nativeDescriptorSnapshotPlanOf } from './native-descriptor-snapshot.js'
import { nativeLogicalReceiverRecipeOf } from './native-logical-receiver.js'
import { abiOfCallee } from '../projection/callee.js'
import { dynamicWrapperDependenciesOf, dynamicWrapperPlanOf } from './dynamic-wrapper.js'
import { nativeSumPayloadCapabilityMatches } from './native-sum.js'

const containsSharedStructuralRecord = (value: Representation): boolean => {
  if (value.kind === 'optional') return containsSharedStructuralRecord(value.payload)
  if (value.kind === 'tagged-union') return value.arms.some((arm) => containsSharedStructuralRecord(arm.value))
  if (value.kind === 'array-object') return containsSharedStructuralRecord(value.element)
  if (value.kind === 'promise') return containsSharedStructuralRecord(value.value)
  return (
    (value.kind === 'record' && value.ownership === 'shared-refcount' && value.accessors.length === 0) ||
    (value.kind === 'record-with-index' && value.ownership === 'shared-refcount') ||
    (value.kind === 'native-record-ref' && value.native === null && value.ownership === 'shared-refcount')
  )
}

/** A table entry that is a shared structural record (or its optional): the entries a Document view reads live. */
const dictionaryEntriesAreSharedRecords = (value: Representation): boolean =>
  value.kind === 'optional'
    ? dictionaryEntriesAreSharedRecords(value.payload)
    : value.kind !== 'tagged-union' && value.kind !== 'array-object' && containsSharedStructuralRecord(value)

const containsArray = (value: Representation): boolean =>
  value.kind === 'array-object' ||
  (value.kind === 'optional' && containsArray(value.payload)) ||
  (value.kind === 'promise' && containsArray(value.value)) ||
  (value.kind === 'tagged-union' && value.arms.some((arm) => containsArray(arm.value)))

/**
 * The conversion census: ONE node per (source, target) pair, minted on
 * demand and remembered.
 *
 * `buildConversionGraph` mints eagerly the pairs it can enumerate from the
 * plan -- dynamic into every referenced carrier, and the narrowing, widening
 * and recasting pairs its closures propose. Every other pair the program
 * needs was answered nowhere until the printer ran its ordered chain over
 * the two carriers at the site, which is how a program certified against
 * one authority and refused under another. This census is the single
 * question `slotOf` answers lead to: the lowering asks `nodeFor(source,
 * slot)` when an operand's carrier differs from its slot's, records the
 * node on the `convert` instruction, and the printer renders THAT node's
 * recipe. A pair with no recipe is a `never` node here, before the IR is
 * built, and the certificate refuses it by name.
 *
 * Order of authority for a pair, first answer wins:
 *   1. identity -- the same carrier;
 *   2. the eager graph's node, when it minted one;
 *   3. dynamic source -- the derivation over the target (what the eager
 *      graph would have minted had the target been referenced);
 *   4. the registry's narrowing, widening, recasting pair, in that order;
 *   5. the registry's static recipe;
 *   6. `never`, with the reason stated.
 * Steps 4 and 5 are the same two tables the eager graph and the printer
 * already read; nothing here decides a pair on its own.
 */
export interface ConversionCensus {
  readonly nativeDescriptorSnapshotFor: (
    context: string,
    plan: import('./native-descriptor-snapshot.js').NativeDescriptorSnapshotPlan
  ) => ConversionNode | null
  /** A source-owned allocation and complete writer schema, independently replayed at the conversion site. */
  readonly nativeObjectSampleFor: (
    context: string,
    plan: import('./native-object-sample.js').NativeObjectSamplePlan
  ) => ConversionNode | null
  readonly dictionaryReadFor: (source: Representation, target: Representation) => ConversionNode | null
  readonly readOnlyDictionaryFor: (source: Representation, target: Representation) => ConversionNode | null
  readonly callArgumentFor: (source: Representation, target: Representation) => ConversionNode
  readonly fieldReadFor: (source: Representation, target: Representation) => ConversionNode
  /** The selected live view's checked primitive reader, replayed on its original native storage. */
  readonly checkedFieldReadFor: (source: Representation, target: Representation, checked: ConversionNode) => ConversionNode | null
  readonly absentIndexReadFor: (source: Representation, target: Representation) => ConversionNode
  readonly nativeMethodFor: (source: Representation, target: Representation) => ConversionNode | null
  readonly nativeBufferMethodFor: (source: Representation, target: Representation) => ConversionNode | null
  readonly nodeFor: (source: Representation, target: Representation) => ConversionNode
  /**
   * The node for an abstract operation over a source: `ToNumber` lands on
   * `scalar(number)`, `ToString` on `string`. Not `nodeFor(source, number)`,
   * which is the STORE of a source into a number cell -- an exact tag read
   * for a dynamic source, `never` for a string -- where the coercion accepts
   * every value the carrier holds and computes the language's answer. The
   * two share a (source, target) pair and nothing else, so the coercion
   * node's id carries the operation's name and lives in its own table.
   */
  readonly coercionFor: (source: Representation, operation: CoercionOperation) => ConversionNode
  /**
   * The exact-arm projection of a tagged union into the one arm whose carrier
   * IS the target: `get<k>()` guarded by `is<k>()`, a `TypeError` otherwise.
   * `null` where the source is not a tagged union or the target is not
   * exactly one of its arms -- the pair then belongs to `nodeFor`.
   *
   * Its own table for the same reason coercions have one: the pair
   * `tagged-union(...) -> arm` already names `nodeFor`'s dispatch node, which
   * converts EVERY arm into the target (a callable arm through an adapter, a
   * class arm through an upcast), and only the instruction's own node id says
   * which of the two runs. Minted only for an owner whose declaration states
   * `@gea-exact-arms` (`LoweringContext.exactArmNarrowing`): the projection
   * trades a conversion the checker proved total for a runtime check the
   * author vouched for, so nothing mints it on its own initiative.
   *
   * A `static` capability with `nativeFieldProtocol: 'unused'` and every
   * transport preserved: the value handed on is the arm's own payload,
   * untouched, so no field protocol, adapter or fresh alias is involved --
   * which is exactly the proof the reflection census needs to leave the
   * arm's parameters un-promoted.
   */
  readonly exactArmFor: (source: Representation, target: Representation) => ConversionNode | null
  /**
   * An instance of a class extending a native collection, read AS that
   * collection for one of the collection's own members
   * (`SemanticOperand.nativeBaseView`): `super.get(k)`, or `lower.size` where
   * no class in the family redeclares `size`. The same upcast the ordinary
   * store renders, minted even for a family that redeclares OTHER members,
   * which is exactly the case `nodeFor` must refuse. `null` for any other pair.
   */
  readonly nativeBaseViewFor: (source: Representation, target: Representation) => ConversionNode | null
  /**
   * A census-built sum read as the one native collection the program asserts
   * it is (`lower-operands.ts`'s `assertedCensusUnionReceiver`): every arm is
   * that collection, a box, or an open Document that may view one, and EACH
   * is converted -- the collection as it is, the box through its checked
   * unbox, the Document through the object it views. `nodeFor`'s answer for
   * the same pair selects the collection's arm by its tag, which misreads a
   * boxed or viewed Map. `null` for any other pair.
   */
  readonly armViewFor: (source: Representation, target: Representation) => ConversionNode | null
  /**
   * A tagged union the program's own `as T` asserts to ONE carrier that some
   * arm cannot convert into. The assertion proves nothing about which arm is
   * live (a flow narrowing would), so `nodeFor`'s selection -- an unchecked
   * `get<k>()` of the arm that converts -- is wrong for the other arms: it
   * aborted on a live `unknown[]` arm of `(cond ? items[0] : items) as S[]`.
   * This node dispatches on the live arm instead: an arm that converts does,
   * an `Array<any>` arm is rebuilt element-wise with each element checked, and
   * an arm that cannot be the target is a `TypeError`. `null` for a source that
   * is not a union or a target that is a union, a box or an optional (those
   * have their own whole-union recipes).
   */
  readonly assertedUnionFor: (source: Representation, target: Representation, copyAllowed: boolean) => ConversionNode | null
  /**
   * A structural record the program asserts (`/** @type {C | ...} *\/ (x)`) into
   * a slot whose only object homes are classes, where nothing else converts
   * the pair. A record value is one of those classes only as a view of that
   * class's allocation, so the node tests the view's origin per class arm
   * (`gea::record::viewOriginClassIs`) and loads that allocation; a record
   * that is no such view -- or one that cannot be a view at all -- is the
   * assertion failing, a `TypeError` like `exactArmFor`'s. An absent source
   * converts as its own absence. `null` when the target has no class home or
   * cannot hold the source's absence.
   */
  readonly assertedViewFor: (source: Representation, target: Representation) => ConversionNode | null
  /**
   * A record entering a slot whose record arm is an interface FAMILY's
   * layout, viewed knowing which members of the family the site named
   * (`record-view.ts`'s `FamilyMemberKeys`). `nodeFor`'s answer for the same
   * pair is keyed by carriers alone and cannot tell a site that named a
   * member lacking a layout field from one whose member declares it, so it
   * must refuse a source that cannot fill that field; this node is asked
   * only after it did, by a site that published the member it names. `null`
   * where even the member's own keys leave no view.
   */
  readonly familyMemberViewFor: (source: Representation, target: Representation, members: FamilyMemberKeys) => ConversionNode | null
  /**
   * A CAUGHT value -- a `catch (error)` binding typed `any` -- handed to a
   * class-typed slot: the checked read of the class instance, which, when the
   * thrown value is not one, rethrows that value rather than aborting.
   * `catch (error) { return operation.handleError(error) }` with
   * `handleError(error: KnownError)`, whose every implementation rethrows what
   * it does not recognize, is the case; in JS a non-`KnownError` reaches it and propagates as the operation's rejection.
   * The slot cannot hold that value, so the handoff itself propagates it.
   * `null` for any other pair.
   */
  readonly caughtHandoffFor: (source: Representation, target: Representation) => ConversionNode | null
  /**
   * A base class handle the program's own `as Derived` asserts to a
   * DESCENDANT, read for a member only the descendant declares
   * (`properties.ts`'s `assertsDescendantClassOfUnionArm`): the class
   * downcast, CHECKED against the allocation's authenticated class chain, and
   * a `TypeError` when the object is not that class. The ordinary pair's
   * downcast (`downcastClassRef`) trusts an `instanceof` guard the emitter
   * itself rendered; an assertion renders no guard, so trusting it would store
   * a descendant's field through a base object's bytes. `null` unless the
   * target is a class-ref descending from the source's class under the same
   * ownership.
   */
  readonly assertedClassDowncastFor: (source: Representation, target: Representation) => ConversionNode | null
  /**
   * An `any` argument entering an OPTIONAL parameter (`x?: T`, no default)
   * whose payload has no `null` state: a `null` the value holds reads as the
   * parameter's absence. A function keeping `let thrownError = null` (typed
   * `any`) and, on success, passing it to `merge(..., err?: AnyError, ...)` is
   * the case. The callee was checked against `T | undefined`, so
   * the only null it can see is one an `any` smuggled past that check; it has
   * no default initializer that could tell the two apart. `null` for any
   * other pair.
   */
  readonly nullishOptionalFor: (source: Representation, target: Representation) => ConversionNode | null
  /** The node a `convert` instruction names, from whichever table minted it; `null` for an id no census minted. */
  readonly nodeById: (id: ConversionNodeId) => ConversionNode | null
  /** Every node minted through `nodeFor` that the eager graph did not already hold. */
  readonly minted: ReadonlyMap<ConversionNodeId, ConversionNode>
}

export interface ConversionCensusInput {
  readonly registry: ConversionRuntimeRegistry
  readonly nodes: ReadonlyMap<ConversionNodeId, ConversionNode>
}

/**
 * Why a callable whose convention takes a receiver of class `X` cannot become
 * one taking a receiver of class `Y` that does not extend `X`, or `null` for
 * any other pair.
 *
 * `X.prototype.m.call(y, ...)` is the program shape: a library borrowing
 * `CaseInsensitiveMap.prototype._normalizeKey` onto its `URLSearchParams`
 * subclass. The body was compiled against `X`'s layout and
 * dispatch -- its `this.keys()` is `Map`'s -- and no conversion of the function
 * VALUE can retarget that; running it on a `Y` needs the body compiled again
 * for `Y`, which this compiler does not do. The pair was already refused; this
 * says why, rather than naming only the two carriers.
 */
const foreignReceiverOf = (source: Representation, target: Representation): string | null => {
  // The receiver itself, handed to a method of the unrelated class: the
  // lowered form of the same borrow when the callee is resolved directly.
  if (source.kind === 'class-ref' && target.kind === 'class-ref') {
    if (source.declaration === target.declaration || source.ancestors.includes(target.declaration)) return null
    if (target.ancestors.includes(source.declaration)) return null
    return (
      `an instance of class ${source.declaration} is used where class ${target.declaration} is declared, and neither extends the ` +
      `other: a compiled instance has its own class's layout, so no conversion makes it one of the other (a borrowed method, ` +
      `\`${target.declaration}.prototype.m.call(instance)\`, would need the body compiled again for the instance's class)`
    )
  }
  if (!('abi' in source) || !('abi' in target)) return null
  const from = (source.abi as { readonly receiver: Representation | null }).receiver
  const into = (target.abi as { readonly receiver: Representation | null }).receiver
  if (from?.kind !== 'class-ref' || into?.kind !== 'class-ref') return null
  if (into.declaration === from.declaration || into.ancestors.includes(from.declaration)) return null
  if (from.ancestors.includes(into.declaration)) return null
  return (
    `a method compiled for receivers of class ${from.declaration} is called with a receiver of class ${into.declaration}, ` +
    `which does not extend it (\`${from.declaration}.prototype.m.call(receiver)\`): the body is compiled against its own ` +
    "class's layout and dispatch, and running it on another class would need a copy of the body compiled for that class"
  )
}

export const conversionNodeIdOf = (source: Representation, target: Representation): ConversionNodeId =>
  `${representationKey(source)}->${representationKey(target)}`

/** The carrier each abstract operation lands on. */
export const coercionTargetOf = (operation: CoercionOperation): Representation =>
  operation === 'ToNumber' ? { kind: 'scalar', domain: 'number' } : { kind: 'string' }

const containsUnresolved = (representation: Representation): boolean => representationKey(representation).includes('unresolved')

const exactAccessorPayloadOf = (capability: ConversionCapability): boolean =>
  capability.kind === 'optional'
    ? exactAccessorPayloadOf(capability.payload)
    : capability.kind === 'atom' &&
      capability.classifier.domain === capability.materializer.domain &&
      capability.materializer.nativeAccessorPayload === 'preserved' &&
      capability.materializer.nativeFieldProtocol === 'unused' &&
      capability.materializer.nativePayloadTransport === 'preserved' &&
      !capability.materializer.allocates

const registeredRecordPayloadOf = (
  capability: ConversionCapability,
  target: Representation,
  registry: ConversionRuntimeRegistry
): boolean => {
  if (capability.kind === 'optional' && target.kind === 'optional')
    return registeredRecordPayloadOf(capability.payload, target.payload, registry)
  if (capability.kind !== 'atom' || target.kind !== 'native-record-ref' || target.ownership !== 'shared-refcount') return false
  const installed = registry.recordRefMaterializer(target.shapeId, target.ownership)
  return (
    installed !== null &&
    installed.materializer.wrapperKind === 'unbox-payload' &&
    capability.classifier.id === installed.classifier.id &&
    capability.classifier.domain === installed.classifier.domain &&
    capability.materializer.id === installed.materializer.id &&
    capability.materializer.domain === installed.materializer.domain &&
    capability.classifier.domain === capability.materializer.domain &&
    capability.materializer.nativeFieldProtocol === 'unused' &&
    capability.materializer.nativePayloadTransport === 'preserved' &&
    !capability.materializer.allocates &&
    installed.materializer.nativeFieldProtocol === 'unused' &&
    installed.materializer.nativePayloadTransport === 'preserved' &&
    !installed.materializer.allocates
  )
}

export const createConversionNodes = (input: ConversionCensusInput): ConversionCensus => {
  const minted = new Map<ConversionNodeId, ConversionNode>()
  /** Every pair being derived, at the depth of its derivation frame. */
  const deriving = new Map<ConversionNodeId, number>()
  /**
   * The shallowest open pair the current derivation re-entered, or `Infinity`.
   * A re-entered pair answers `never` while it is open, and that answer is an
   * assumption, not a fact: a Document view of a self-referential `image`
   * record asks for its own optional read, and a refusal of that read minted
   * inside the view's derivation was kept for the whole unit after the view
   * itself succeeded. A result that saw such an assumption -- directly or
   * through any child -- is provisional until the re-entered pair closes.
   */
  let shallowestReentry = Infinity
  /**
   * Provisional results, keyed by pair, with the depth of the open pair they
   * assumed. Within one open component a pair answers exactly one way, so a
   * recipe never cites two derivations of one pair. When the component's head
   * closes, a provisional refusal is discarded -- it assumed a pair that now
   * has its real answer, so asking again derives against that answer -- and
   * every other provisional result is committed: the head's own recipe cites
   * those nodes by identity, and each is a finite proof that cites no
   * assumption.
   */
  const provisional = new Map<ConversionNodeId, { readonly node: ConversionNode; readonly assumes: number }>()
  const context = createConversionDerivationContext(input.registry)

  const capabilityOf = (source: Representation, target: Representation, sourceKey: string, targetKey: string): ConversionCapability => {
    if (sourceKey === targetKey) return { kind: 'identity' }
    if (target.kind === 'void') {
      return { kind: 'static', materializer: { id: 'chain:discard-into-void', domain: 'static:discard-into-void', allocates: false } }
    }
    if (source.kind === 'void') return { kind: 'never', reason: `a void source has no value to convert into ${targetKey}` }
    if (standInRefuses(source, target)) return { kind: 'never', reason: `${targetKey} is a stand-in record only its own shape moves into` }
    if (containsUnresolved(source) || containsUnresolved(target)) {
      return { kind: 'never', reason: `an unresolved carrier in ${sourceKey} -> ${targetKey} names no conversion` }
    }
    if (source.kind === 'dynamic') {
      if (source.reason !== 'untyped-callable') {
        const installed = input.registry.widening(source, target)
        if (installed) {
          const native: ConversionCapability = { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
          if (nativeSumPayloadCapabilityMatches(source, target, native)) return native
        }
      }
      // The eager graph keys its dynamic-source nodes by the target alone and
      // mints them from one generic dynamic carrier; a dynamic source with a
      // different reason is the same conversion, so the same node answers.
      const eager = input.nodes.get(targetKey)
      if (eager !== undefined) return eager.capability
      return deriveConversionCapability(target, context)
    }
    // `narrowing` asked first and on its own, never folded into the generic
    // loop below: its pair can need `class-family` rather than a plain
    // `atom` (`build.ts`'s `narrowingCapabilityFor` says why), a distinction
    // only meaningful for a narrowing answer -- widening and recasting pairs
    // never reach a base-class-narrowed-to-descendant-union shape.
    const narrowed = input.registry.narrowing(source, target)
    if (narrowed) return narrowingCapabilityFor(source, target, narrowed)
    for (const table of [input.registry.widening, input.registry.recasting]) {
      const installed = table(source, target)
      if (installed) return { kind: 'atom', classifier: installed.classifier, materializer: installed.materializer }
    }
    // An admitted ordinary static recipe precedes structural reconstruction.
    // The registry marks its final fallback recipes so a sealed structural
    // proof can precede those without changing the ordinary recipe's reads or
    // allocation ownership. The same order applies to eager fallback nodes.
    const recipe = input.registry.staticRecipe(source, target)
    if (recipe && !recipe.staticRecipeFallback) return { kind: 'static', materializer: recipe }
    const structural = input.registry.structuralRecipe?.(
      source,
      target,
      nodeFor,
      undefined,
      nativeMethodFor,
      nodeById,
      dictionaryReadFor,
      assertedClassDowncastFor
    )
    if (structural) return { kind: 'static', materializer: structural }
    if (recipe) return { kind: 'static', materializer: recipe }
    const foreign = foreignReceiverOf(source, target)
    const missing = `no runtime conversion is installed from ${sourceKey} to ${targetKey}`
    return { kind: 'never', reason: foreign === null ? missing : `${missing}: ${foreign}` }
  }

  const nodeFor = (source: Representation, target: Representation): ConversionNode => {
    const sourceKey = representationKey(source)
    const targetKey = representationKey(target)
    const id = `${sourceKey}->${targetKey}`
    const remembered = minted.get(id)
    if (remembered !== undefined) return remembered
    const pending = provisional.get(id)
    if (pending !== undefined) {
      shallowestReentry = Math.min(shallowestReentry, pending.assumes)
      return pending.node
    }
    const open = deriving.get(id)
    if (open !== undefined) {
      shallowestReentry = Math.min(shallowestReentry, open)
      return { id, source, target, capability: { kind: 'never', reason: `recursive structural conversion ${id} has no finite leaf proof` } }
    }
    const depth = deriving.size
    deriving.set(id, depth)
    const outerReentry = shallowestReentry
    shallowestReentry = Infinity
    let capability: ConversionCapability
    try {
      const eager = input.nodes.get(id)
      capability =
        eager !== undefined &&
        !((eager.capability.kind === 'static' || eager.capability.kind === 'atom') && eager.capability.materializer.staticRecipeFallback)
          ? eager.capability
          : capabilityOf(source, target, sourceKey, targetKey)
      const nativeRecord = target.kind === 'optional' ? target.payload : target
      // An open Document read as an Array is the Array it views: the same live
      // view a boxed Array gets, never an element-wise copy that loses writes.
      if (target.kind === 'array-object' && (source.kind === 'dynamic' || source.kind === 'array-object' || isOpenDocument(source))) {
        const array = input.registry.nativeArrayViewRecipe?.(source, target, nodeFor, dictionaryReadFor, nodeById)
        if (array?.materializer.nativeArrayView)
          capability = source.kind === 'dynamic' ? { kind: 'atom', ...array } : { kind: 'static', materializer: array.materializer }
        else if (
          // A pair that already refuses keeps its own, more specific reason.
          capability.kind !== 'never' &&
          (source.kind === 'dynamic' ||
            (source.kind === 'array-object' &&
              source.ownership === 'shared-refcount' &&
              target.ownership === 'shared-refcount' &&
              representationKey(source.element) !== representationKey(target.element) &&
              // An installed recast between two element carriers that mints
              // nothing is the same object read through the other element
              // (`gea::emptyArraySentinel` is the one such pair): it has no
              // copy to lose a later write, so it needs no live view.
              !((capability.kind === 'atom' || capability.kind === 'static') && !capability.materializer.allocates)))
        ) {
          capability = { kind: 'never', reason: `${target.kind} ${id} has no selected live native array reader` }
        }
      }
      if (
        source.kind === 'dynamic' &&
        source.reason !== 'untyped-callable' &&
        (nativeRecord.kind === 'record' ||
          nativeRecord.kind === 'record-with-index' ||
          (nativeRecord.kind === 'native-record-ref' && nativeRecord.native === null)) &&
        nativeRecord.ownership === 'shared-refcount' &&
        !exactAccessorPayloadOf(capability)
      ) {
        // An optional record follows its payload's own selection: a payload
        // recovered as its exact registered native object is wrapped below,
        // never re-read through a document view the payload itself refused.
        // Otherwise the answer would depend on which of the two pairs the
        // census happened to mint first.
        const payload = target.kind === 'optional' ? nodeFor(source, target.payload).capability : null
        const sealed =
          payload === null || ('materializer' in payload && payload.materializer.documentRecordView)
            ? input.registry.structuralRecipe?.(
                source,
                target,
                nodeFor,
                undefined,
                nativeMethodFor,
                nodeById,
                dictionaryReadFor,
                assertedClassDowncastFor
              )
            : undefined
        capability = sealed?.documentRecordView
          ? { kind: 'static', materializer: sealed }
          : registeredRecordPayloadOf(capability, target, input.registry)
            ? capability
            : { kind: 'never', reason: `shared dynamic record ${id} has no admitted live field view` }
      }
      if (
        source.kind === 'dynamic' &&
        (containsSharedStructuralRecord(target) || containsArray(target)) &&
        (target.kind === 'optional' || target.kind === 'promise' || target.kind === 'tagged-union') &&
        !nativeSumPayloadCapabilityMatches(source, target, capability) &&
        !('materializer' in capability && capability.materializer.documentRecordView) &&
        // An exact accessor payload keeps its own authenticated contract
        // through absence, exactly as the shared-record branch above keeps it.
        !exactAccessorPayloadOf(capability)
      ) {
        const plan = dynamicWrapperPlanOf(source, target, capability, nodeFor, nodeById)
        capability = plan
          ? {
              kind: 'static',
              materializer: {
                id: 'dynamic-wrapper',
                domain: `dynamic-wrapper:${targetKey}`,
                allocates:
                  plan.kind === 'promise' ||
                  dynamicWrapperDependenciesOf(plan).some(
                    (child) => 'materializer' in child.capability && child.capability.materializer.allocates
                  ),
                executesSourceGuard: true,
                dynamicWrapper: plan,
                dependencies: dynamicWrapperDependenciesOf(plan)
              }
            }
          : { kind: 'never', reason: `dynamic wrapper ${id} has no selected native structural payload readers` }
      }
      if (capability.kind === 'static' || capability.kind === 'atom') {
        const targetReceiver = source.kind === 'dynamic' ? abiOfCallee(target)?.receiver : null
        if (capability.materializer.wrapperKind === 'dynamic-carrier-in' && targetReceiver) {
          const receiver = nativeLogicalReceiverRecipeOf(targetReceiver, nodeFor, nodeById)
          capability =
            receiver === null
              ? { kind: 'never', reason: `dynamic callable ${id} has no native physical receiver transport` }
              : {
                  ...capability,
                  materializer: {
                    ...capability.materializer,
                    nativeLogicalReceiver: receiver,
                    dependencies: [...(capability.materializer.dependencies ?? []), ...receiver.materializers]
                  }
                }
        }
        // The constructed object is read back the way any boxed value of the
        // frame's result carrier is: by this census's own reader, never a
        // runtime payload match a class instance read as a record would fail.
        if (
          capability.kind !== 'never' &&
          capability.materializer.wrapperKind === 'dynamic-constructor-in' &&
          target.kind === 'constructor-value-dispatch'
        ) {
          const result = nodeFor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, target.abi.result)
          capability =
            result.capability.kind === 'never' || !recipeIsMaterializableWithoutPriorSourceGuard(result, nodeById)
              ? { kind: 'never', reason: `dynamic constructor ${id} has no checked reader of its constructed result` }
              : {
                  ...capability,
                  materializer: {
                    ...capability.materializer,
                    constructedResult: result,
                    dependencies: [...(capability.materializer.dependencies ?? []), result]
                  }
                }
        }
      }
      if (capability.kind === 'static' || capability.kind === 'atom') {
        // A conditional can have one exact record arm and another record
        // that satisfies the same interface. Dispatch the complete source
        // when its native view is admitted; selecting the exact arm would
        // discard the other live value.
        if (
          source.kind === 'tagged-union' &&
          (target.kind === 'record' || (target.kind === 'native-record-ref' && target.native === null)) &&
          (capability.materializer.armSelection !== undefined || capability.materializer.nativeSelection !== undefined)
        ) {
          const complete = input.registry.structuralRecipe?.(
            source,
            target,
            nodeFor,
            undefined,
            nativeMethodFor,
            nodeById,
            dictionaryReadFor,
            assertedClassDowncastFor
          )
          if (complete?.recordView?.view.kind === 'dispatch') capability = { kind: 'static', materializer: complete }
        }
        // A dynamic object read as a typed table of records: the boxed round
        // trip admits only a table this program boxed, and the copying unbox
        // behind it rebuilds the table and refuses every entry that is not
        // that record's exact payload. When the table's entries have a live
        // Document view, the object is viewed instead -- the same object, each
        // entry the stored entry seen through the record's layout. The view
        // still hands back a table this program boxed at this carrier as itself.
        if (
          source.kind === 'dynamic' &&
          source.reason !== 'untyped-callable' &&
          target.kind === 'dictionary' &&
          target.key === 'string' &&
          target.value.kind !== 'dynamic' &&
          (capability.materializer.wrapperKind === 'unbox-tag' || capability.materializer.wrapperKind === 'unbox-payload') &&
          dictionaryEntriesAreSharedRecords(target.value)
        ) {
          const viewed = input.registry.structuralRecipe?.(
            source,
            target,
            nodeFor,
            undefined,
            nativeMethodFor,
            nodeById,
            dictionaryReadFor,
            assertedClassDowncastFor
          )
          if (viewed?.dictionaryView !== undefined) capability = { kind: 'static', materializer: viewed }
        }
        const materializer = capability.materializer
        if (structuralRecipeRequiredFor({ id, source, target, capability })) {
          const sealed = input.registry.structuralRecipe?.(
            source,
            target,
            nodeFor,
            undefined,
            nativeMethodFor,
            nodeById,
            dictionaryReadFor,
            assertedClassDowncastFor
          )
          capability =
            sealed?.recordView ||
            sealed?.documentRecordView ||
            sealed?.callableView ||
            sealed?.callablePayload ||
            sealed?.iteratorObjectView ||
            sealed?.iterableObjectView ||
            sealed?.protocolIterator
              ? // The structural recipe replaces the provisional transport
                // contract. A missing unused-field claim is meaningful: merging
                // the old claim would hide a live dynamic accessor's receiver
                // exposure. Only the atom's classifier identity remains fixed.
                { ...capability, materializer: { ...sealed, id: materializer.id, domain: materializer.domain } }
              : { kind: 'never', reason: `structural conversion ${id} has no admitted leaf plan` }
        } else if (materializer.id === 'gea::Promise::adopt-converted' && source.kind === 'promise' && target.kind === 'promise') {
          const plan = promiseAdoptionPlanOf(source, target, nodeFor, nodeById)
          capability =
            plan === null
              ? { kind: 'never', reason: `promise conversion ${id} has no admitted completion plan` }
              : {
                  ...capability,
                  materializer: {
                    ...materializer,
                    promiseAdoption: plan,
                    dependencies: plan.kind === 'payload-transfer' ? [plan.conversion] : []
                  }
                }
        }
      }
    } finally {
      deriving.delete(id)
    }
    const assumes = shallowestReentry
    shallowestReentry = Math.min(outerReentry, assumes)
    // A membership view, not a Set copied from both tables: the copy was made
    // once per minted pair, quadratic in the census, and was the single
    // largest lowering cost on a large program (over half of it).
    validateCapability(capability, {
      has: (known) => known === id || input.nodes.has(known) || minted.has(known) || provisional.has(known)
    })
    const node: ConversionNode = { id, source, target, capability }
    if (assumes < depth) {
      // Whatever this derivation recorded as provisional now rests on the
      // same open ancestor this result does: depths are reused by later
      // frames, so the entries are re-pointed at that ancestor's.
      for (const [pendingId, entry] of provisional) if (entry.assumes >= depth) provisional.set(pendingId, { node: entry.node, assumes })
      provisional.set(id, { node, assumes })
      return node
    }
    minted.set(id, node)
    // This pair closes every component it heads: nothing still open was
    // assumed by a result recorded while it was being derived.
    for (const [pendingId, entry] of provisional) {
      if (entry.assumes < depth) continue
      provisional.delete(pendingId)
      if (entry.node.capability.kind !== 'never') minted.set(pendingId, entry.node)
    }
    return node
  }

  const contextual = new Map<ConversionNodeId, ConversionNode>()
  const contextualNode = (
    source: Representation,
    target: Representation,
    context: string,
    materializer: import('./algebra.js').MaterializerContract
  ): ConversionNode => {
    const id = `${conversionNodeIdOf(source, target)}#${context}`
    const remembered = contextual.get(id)
    if (remembered) return remembered
    const node: ConversionNode = { id, source, target, capability: { kind: 'static', materializer } }
    contextual.set(id, node)
    return node
  }
  const readOnlyDictionaryFor = (source: Representation, target: Representation): ConversionNode | null => {
    const materializer = input.registry.readOnlyDictionaryRecipe?.(source, target, nodeFor, nodeById, dictionaryReadFor)
    return materializer?.readOnlyDictionary === undefined ? null : contextualNode(source, target, 'read-only-dictionary', materializer)
  }
  const nativeObjectSampleFor = (
    context: string,
    plan: import('./native-object-sample.js').NativeObjectSamplePlan
  ): ConversionNode | null => {
    if (context.length === 0) return null
    const sealed = nativeObjectSamplePlanOf(plan.source, plan.target, plan.fields, nodeById)
    if (sealed === null) return null
    // Different writer states of one allocation must never reuse a plan just
    // because their public source and destination carriers happen to agree.
    const inventory = sealed.fields.map((entry) => [
      entry.field.key,
      entry.from,
      representationKey(entry.storage),
      entry.presence,
      entry.present.id,
      entry.absent?.id ?? null
    ])
    return contextualNode(sealed.source, sealed.target, `native-object-sample:${JSON.stringify([context, inventory])}`, {
      id: 'native-object-sample',
      domain: 'static:native-object-sample',
      allocates: true,
      nativeObjectSample: sealed,
      dependencies: [
        ...new Map(
          sealed.fields.flatMap((entry) => [entry.present, ...(entry.absent ? [entry.absent] : [])]).map((child) => [child.id, child])
        ).values()
      ]
    })
  }
  const nativeDescriptorSnapshotFor = (
    context: string,
    plan: import('./native-descriptor-snapshot.js').NativeDescriptorSnapshotPlan
  ): ConversionNode | null => {
    if (context.length === 0) return null
    const sealed = nativeDescriptorSnapshotPlanOf(plan.source, plan.target, plan.fields, plan.originalAny, nodeById)
    if (sealed === null) return null
    const inventory = sealed.fields.map((entry) => [entry.field.key, entry.reads.map((read) => read.id)])
    return contextualNode(
      sealed.source,
      sealed.target,
      `native-descriptor-snapshot:${JSON.stringify([context, sealed.originalAny, inventory])}`,
      {
        id: 'native-descriptor-snapshot',
        domain: 'static:native-descriptor-snapshot',
        allocates: true,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved',
        nativeFieldViewProtocol: 'live',
        nativeDescriptorSnapshot: sealed,
        dependencies: sealed.dependencies
      }
    )
  }
  const dictionaryReadFor = (source: Representation, target: Representation): ConversionNode | null => {
    const ordinary = nodeFor(source, target)
    if (ordinary.capability.kind === 'never') return null
    const materializer = input.registry.dictionaryReadRecipe?.(ordinary)
    if (materializer !== undefined && materializer !== null) return contextualNode(source, target, 'dictionary-entry-read', materializer)
    if (
      source.kind === 'dynamic' &&
      target.kind === 'optional' &&
      ordinary.capability.kind === 'optional' &&
      ordinary.capability.payload.kind === 'never'
    ) {
      // `globalThis as unknown as { SomeGlobal?: Ctor }`: a present entry has
      // no native reader, so the pair refuses at compile time rather than
      // certifying a read whose every present value is a run-time TypeError.
      return null
    }
    if (source.kind === 'dynamic' && target.kind === 'optional') {
      const present = dictionaryReadFor(source, target.payload)
      const absent = nodeFor({ kind: target.absence }, target)
      if (
        !present ||
        !recipeIsMaterializableWithoutPriorSourceGuard(present, nodeById) ||
        !recipeIsMaterializableWithoutPriorSourceGuard(absent, nodeById)
      )
        return null
      return contextualNode(source, target, 'dictionary-entry-read', {
        id: 'view:checked-dictionary-entry',
        domain: 'static:checked-dictionary-entry',
        allocates: 'materializer' in present.capability && present.capability.materializer.allocates,
        requiresSourceGuard: true,
        executesSourceGuard: true,
        dictionaryRead: { kind: 'dynamic-optional', conversion: ordinary, target, present, absent },
        dependencies: [ordinary, present, absent]
      })
    }
    return ordinary
  }
  const fieldReadFor = (source: Representation, target: Representation): ConversionNode => {
    const method = nativeMethodFor(source, target)
    if (method) return method
    const ordinary = nodeFor(source, target)
    if (ordinary.capability.kind !== 'never' || !impossibleFieldReadOf(source, target)) return ordinary
    return contextualNode(source, target, 'field-read', {
      id: IMPOSSIBLE_FIELD_READ,
      domain: 'static:impossible-field-read',
      allocates: false,
      normalCompletion: 'never',
      nativeFieldProtocol: 'unused'
    })
  }
  const callArgumentFor = (source: Representation, target: Representation): ConversionNode => {
    const ordinary = nodeFor(source, target)
    if (ordinary.capability.kind !== 'never' || !siblingClassArgumentOf(source, target)) return ordinary
    return contextualNode(source, target, 'call-argument', {
      id: SIBLING_CLASS_ARGUMENT,
      domain: 'static:sibling-class-argument',
      allocates: false,
      nativeFieldProtocol: 'unused'
    })
  }
  const checkedFieldReadFor = (source: Representation, target: Representation, checked: ConversionNode): ConversionNode | null => {
    if (nodeById(checked.id) !== checked || !checkedNativeFieldReadMismatchOf(source, target, checked)) return null
    return contextualNode(source, target, `checked-field-read:${checked.id}`, {
      id: CHECKED_NATIVE_FIELD_READ,
      domain: `static:checked-field-read:${checked.id}`,
      allocates: false,
      normalCompletion: 'never',
      nativeFieldProtocol: 'unused',
      dependencies: [checked],
      checkedNativeFieldRead: { checked }
    })
  }
  const absentIndexReadFor = (source: Representation, target: Representation): ConversionNode => {
    const ordinary = nodeFor(source, target)
    if (ordinary.capability.kind !== 'never') return ordinary
    return contextualNode(source, target, 'index-read', {
      id: IMPOSSIBLE_INDEX_READ,
      domain: 'static:impossible-index-read',
      allocates: false,
      normalCompletion: 'never',
      nativeFieldProtocol: 'unused'
    })
  }
  const nativeMethodFor = (source: Representation, target: Representation): ConversionNode | null => {
    const nativeMethod = nativeUnboundMethodContractOf(source, target)
    if (!nativeMethod) return null
    const frame: Representation = {
      kind: 'function-value-dispatch',
      abi: { ...nativeMethod.target, receiver: nativeMethod.receiver }
    }
    const erased: Representation = { kind: 'function-value-dispatch', abi: { ...nativeMethod.target, receiver: null } }
    const checkedResult = nativeMethod.resultNarrowing
    let frameAdaptation: ConversionNode | null = null
    if (checkedResult !== undefined) {
      const checked = assertedClassDowncastFor(checkedResult.source, checkedResult.target)
      if (checked === null) return null
      const result = contextualNode(checkedResult.source, checkedResult.target, 'native-method-result', {
        id: 'view:checked-native-method-result',
        domain: 'static:checked-native-method-result',
        allocates: false,
        requiresSourceGuard: true,
        executesSourceGuard: true,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved',
        nativeClassReferenceIdentity: 'preserved',
        dependencies: [checked],
        nativeMethodResult: { checked }
      })
      const sealed = input.registry.structuralRecipe?.(
        source,
        frame,
        (from, into) =>
          representationKey(from) === representationKey(result.source) && representationKey(into) === representationKey(result.target)
            ? result
            : nodeFor(from, into),
        undefined,
        nativeMethodFor,
        nodeById,
        dictionaryReadFor,
        assertedClassDowncastFor
      )
      if (sealed?.callableView === undefined) return null
      frameAdaptation = contextualNode(source, frame, 'native-method-result-frame', sealed)
    } else frameAdaptation = representationKey(source) === representationKey(frame) ? null : nodeFor(source, frame)
    const publicAdaptation = nativeMethod.target.receiver === null ? null : nodeFor(erased, target)
    const dependencies = [...(frameAdaptation === null ? [] : [frameAdaptation]), ...(publicAdaptation === null ? [] : [publicAdaptation])]
    return contextualNode(source, target, 'native-method', {
      id: NATIVE_UNBOUND_METHOD_MATERIALIZER,
      domain: 'static:native-unbound-method',
      allocates: true,
      callableIdentityTransport: 'preserved',
      ...(nativeMethod.receiver.kind !== 'dynamic' &&
      [...recipeClosureOf(dependencies, nodeById).values()].every((node) => transfersNativeStorage(node.capability))
        ? { nativeFieldProtocol: 'unused' as const }
        : {}),
      dependencies,
      nativeMethod: {
        ...nativeMethod,
        ...(frameAdaptation === null ? {} : { frameAdaptation }),
        ...(publicAdaptation === null ? {} : { publicAdaptation })
      }
    })
  }
  const nativeBufferMethodFor = (source: Representation, target: Representation): ConversionNode | null => {
    const nativeMethod = nativeBufferUnboundMethodContractOf(source, target)
    if (!nativeMethod) return null
    return contextualNode(source, target, 'native-buffer-method', {
      id: NATIVE_UNBOUND_METHOD_MATERIALIZER,
      domain: 'static:native-buffer-unbound-method',
      allocates: true,
      callableIdentityTransport: 'preserved',
      nativeFieldProtocol: 'unused',
      nativeMethod
    })
  }

  const coercions = new Map<ConversionNodeId, ConversionNode>()
  const coercionFor = (source: Representation, operation: CoercionOperation): ConversionNode => {
    const target = coercionTargetOf(operation)
    const sourceKey = representationKey(source)
    const targetKey = representationKey(target)
    const id = `${sourceKey}->${targetKey}#${operation}`
    const remembered = coercions.get(id)
    if (remembered !== undefined) return remembered
    // A source already in the operation's carrier is the identity: ToNumber
    // of a Number and ToString of a String are the value itself (7.1.4, 7.1.17).
    const capability: ConversionCapability =
      sourceKey === targetKey
        ? { kind: 'identity' }
        : ((): ConversionCapability => {
            const installed = input.registry.coercion(source, operation)
            return installed
              ? { kind: 'coercion', operation, materializer: installed }
              : { kind: 'never', reason: `no ${operation} is installed for ${sourceKey}` }
          })()
    const node: ConversionNode = { id, source, target, capability }
    coercions.set(id, node)
    return node
  }

  const exactArms = new Map<ConversionNodeId, ConversionNode>()
  const exactArmFor = (source: Representation, target: Representation): ConversionNode | null => {
    const index = exactArmIndexOf(source, target)
    if (index === null) return null
    const id = `${representationKey(source)}->${representationKey(target)}#exact-arm`
    const remembered = exactArms.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: EXACT_ARM_MATERIALIZER,
          domain: `static:exact-arm:${index}`,
          allocates: false,
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved',
          nativeClassReferenceIdentity: 'preserved',
          callableIdentityTransport: 'preserved'
        }
      }
    }
    exactArms.set(id, node)
    return node
  }

  const nativeBaseViews = new Map<ConversionNodeId, ConversionNode>()
  const nativeBaseViewFor = (source: Representation, target: Representation): ConversionNode | null => {
    if (!isNativeCollectionUpcast(source, target) && !isNativePromiseUpcast(source, target)) return null
    const id = `${representationKey(source)}->${representationKey(target)}#native-base-view`
    const remembered = nativeBaseViews.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: NATIVE_BASE_VIEW_MATERIALIZER,
          domain: 'static:native-base-view',
          allocates: false,
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved',
          nativeClassReferenceIdentity: 'preserved',
          callableIdentityTransport: 'preserved'
        }
      }
    }
    nativeBaseViews.set(id, node)
    return node
  }

  const armViews = new Map<ConversionNodeId, ConversionNode>()
  const armViewFor = (source: Representation, target: Representation): ConversionNode | null => {
    if (!isArmViewPair(source, target)) return null
    const id = `${representationKey(source)}->${representationKey(target)}#arm-view`
    const remembered = armViews.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: { kind: 'static', materializer: { id: ARM_VIEW_MATERIALIZER, domain: 'static:arm-view', allocates: true } }
    }
    armViews.set(id, node)
    return node
  }

  const assertedUnions = new Map<ConversionNodeId, ConversionNode>()
  const assertedUnionFor = (source: Representation, target: Representation, copyAllowed: boolean): ConversionNode | null => {
    if (source.kind !== 'tagged-union' && !(source.kind === 'optional' && source.payload.kind === 'tagged-union')) return null
    if (target.kind === 'tagged-union' || target.kind === 'dynamic') return null
    const id = `${representationKey(source)}->${representationKey(target)}#asserted-union${copyAllowed ? ':copy' : ''}`
    const remembered = assertedUnions.get(id)
    if (remembered !== undefined) return remembered
    // The dispatch (`emit-narrowing.ts`'s `assertedUnionText`) is a switch on
    // the live tag whose every home is the arm's own conversion into the
    // target or a TypeError. It reads no field protocol of its own, so it is
    // native exactly when each home is: an arm held in the target's carrier,
    // an arm with no conversion (it throws), or an arm whose conversion
    // transfers native storage. The one exception is the copying rebuild of
    // an uncovered `Array<any>` arm, which reads boxed elements.
    const homeIsNative = (arm: Representation): boolean => {
      if (representationKey(arm) === representationKey(target)) return true
      const capability = nodeFor(arm, target).capability
      if (capability.kind === 'never') return !(copyAllowed && arm.kind === 'array-object')
      return transfersNativeStorage(capability)
    }
    const union = source.kind === 'optional' ? source.payload : source
    const native =
      union.kind === 'tagged-union' &&
      union.arms.every((arm) => homeIsNative(arm.value)) &&
      (source.kind !== 'optional' || homeIsNative({ kind: source.absence }))
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: copyAllowed ? ASSERTED_UNION_COPY_MATERIALIZER : ASSERTED_UNION_MATERIALIZER,
          domain: copyAllowed ? 'static:asserted-union-copy' : 'static:asserted-union',
          allocates: copyAllowed,
          ...(native ? { nativeFieldProtocol: 'unused' as const } : {})
        }
      }
    }
    assertedUnions.set(id, node)
    return node
  }

  const assertedViews = new Map<ConversionNodeId, ConversionNode>()
  const assertedViewFor = (source: Representation, target: Representation): ConversionNode | null => {
    const record = source.kind === 'optional' ? source.payload : source
    if (!isStructuralRecordCarrier(record)) return null
    const classArms = assertedViewClassArmsOf(target)
    if (classArms.length === 0) return null
    const absent = source.kind === 'optional' ? nodeFor({ kind: source.absence }, target) : null
    if (absent !== null && absent.capability.kind === 'never') return null
    const id = `${representationKey(source)}->${representationKey(target)}#asserted-view`
    const remembered = assertedViews.get(id)
    if (remembered !== undefined) return remembered
    // An owned record is a value of its own and never views an allocation:
    // every present value is then the assertion failing.
    const views = 'ownership' in record && record.ownership === 'shared-refcount'
    const arms: AssertedViewArm[] = []
    if (views)
      for (const arm of classArms) {
        const load = nodeFor(arm, target)
        if (load.capability.kind === 'never') return null
        arms.push({ declaration: arm.declaration, load })
      }
    const plan: AssertedViewPlan = { views, arms, absent }
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: ASSERTED_VIEW_MATERIALIZER,
          domain: 'static:asserted-view',
          allocates: false,
          // The load is the view's origin allocation itself, read through no
          // field of the record.
          nativeFieldProtocol: 'unused',
          nativeClassReferenceIdentity: 'preserved',
          assertedView: plan,
          dependencies: [...arms.map((arm) => arm.load), ...(absent === null ? [] : [absent])]
        }
      }
    }
    assertedViews.set(id, node)
    return node
  }

  const familyMemberViews = new Map<ConversionNodeId, ConversionNode>()
  const familyMemberViewFor = (source: Representation, target: Representation, members: FamilyMemberKeys): ConversionNode | null => {
    const named = [...members.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([shape, keys]) => `${shape}:${[...keys].sort().join(',')}`)
      .join(';')
    const id = `${representationKey(source)}->${representationKey(target)}#family-members(${named})`
    const remembered = familyMemberViews.get(id)
    if (remembered !== undefined) return remembered
    const materializer =
      input.registry.structuralRecipe?.(
        source,
        target,
        nodeFor,
        members,
        nativeMethodFor,
        nodeById,
        dictionaryReadFor,
        assertedClassDowncastFor
      ) ?? null
    if (materializer === null) return null
    const node: ConversionNode = { id, source, target, capability: { kind: 'static', materializer }, familyMembers: members }
    familyMemberViews.set(id, node)
    return node
  }

  const caughtHandoffs = new Map<ConversionNodeId, ConversionNode>()
  const caughtHandoffFor = (source: Representation, target: Representation): ConversionNode | null => {
    if (source.kind !== 'dynamic' || target.kind !== 'class-ref') return null
    const id = `${representationKey(source)}->${representationKey(target)}#caught-handoff`
    const remembered = caughtHandoffs.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: { kind: 'static', materializer: { id: CAUGHT_HANDOFF_MATERIALIZER, domain: 'static:caught-handoff', allocates: false } }
    }
    caughtHandoffs.set(id, node)
    return node
  }

  const assertedClassDowncasts = new Map<ConversionNodeId, ConversionNode>()
  const assertedClassDowncastFor = (source: Representation, target: Representation): ConversionNode | null => {
    if (source.kind !== 'class-ref' || target.kind !== 'class-ref') return null
    if (source.ownership !== target.ownership || source.declaration === target.declaration) return null
    if (!target.ancestors.includes(source.declaration)) return null
    const id = `${representationKey(source)}->${representationKey(target)}#asserted-class-downcast`
    const remembered = assertedClassDowncasts.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: ASSERTED_CLASS_DOWNCAST_MATERIALIZER,
          domain: `static:asserted-class-downcast:${representationKey(target)}`,
          allocates: false,
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved',
          nativeClassReferenceIdentity: 'preserved',
          callableIdentityTransport: 'preserved'
        }
      }
    }
    assertedClassDowncasts.set(id, node)
    return node
  }

  const nullishOptionals = new Map<ConversionNodeId, ConversionNode>()
  const nullishOptionalFor = (source: Representation, target: Representation): ConversionNode | null => {
    if (source.kind !== 'dynamic' || source.reason === 'untyped-callable' || target.kind !== 'optional' || target.absence !== 'undefined')
      return null
    const id = `${representationKey(source)}->${representationKey(target)}#nullish-optional`
    const remembered = nullishOptionals.get(id)
    if (remembered !== undefined) return remembered
    const payload = nodeFor(source, target.payload)
    if (!recipeIsMaterializableWithoutPriorSourceGuard(payload, nodeById)) return null
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: NULLISH_OPTIONAL_MATERIALIZER,
          domain: 'static:nullish-optional',
          allocates: 'materializer' in payload.capability && payload.capability.materializer.allocates,
          dependencies: [payload]
        }
      }
    }
    nullishOptionals.set(id, node)
    return node
  }

  const nodeById = (id: ConversionNodeId): ConversionNode | null =>
    minted.get(id) ??
    provisional.get(id)?.node ??
    contextual.get(id) ??
    input.nodes.get(id) ??
    coercions.get(id) ??
    exactArms.get(id) ??
    nativeBaseViews.get(id) ??
    armViews.get(id) ??
    assertedUnions.get(id) ??
    assertedViews.get(id) ??
    familyMemberViews.get(id) ??
    caughtHandoffs.get(id) ??
    assertedClassDowncasts.get(id) ??
    nullishOptionals.get(id) ??
    null

  return {
    nativeObjectSampleFor,
    nativeDescriptorSnapshotFor,
    dictionaryReadFor,
    readOnlyDictionaryFor,
    callArgumentFor,
    fieldReadFor,
    checkedFieldReadFor,
    absentIndexReadFor,
    nativeMethodFor,
    nativeBufferMethodFor,
    nodeFor,
    coercionFor,
    exactArmFor,
    nativeBaseViewFor,
    armViewFor,
    assertedUnionFor,
    assertedViewFor,
    familyMemberViewFor,
    caughtHandoffFor,
    assertedClassDowncastFor,
    nullishOptionalFor,
    nodeById,
    minted
  }
}

/** The materializer id every family-member view node carries; the printer dispatches its recipe on it. */
export const FAMILY_MEMBER_VIEW_MATERIALIZER = 'view:family-member-record'
export const IMPOSSIBLE_INDEX_READ = 'native:impossible-index-read'

/** The materializer id every nullish-optional node carries; the printer dispatches its recipe on it. */
export const NULLISH_OPTIONAL_MATERIALIZER = 'view:nullish-optional'

/** The materializer id every asserted-class-downcast node carries; the printer dispatches its recipe on it. */
export const ASSERTED_CLASS_DOWNCAST_MATERIALIZER = 'gea::host::assertedDowncastClassRef'

/** The materializer id every caught-handoff node carries; the printer dispatches its recipe on it. */
export const CAUGHT_HANDOFF_MATERIALIZER = 'view:caught-handoff'

/** The materializer id every native-base view node carries; the printer dispatches its recipe on it. */
export const NATIVE_BASE_VIEW_MATERIALIZER = 'gea::host::nativeBaseView'

/**
 * Whether `target` is exactly the native collection `source`'s class extends
 * (`class-ref.nativeBase`), by carrier key: the pair every native collection
 * upcast -- a store or a view -- spans.
 */
export const isNativeCollectionUpcast = (source: Representation, target: Representation): boolean =>
  source.kind === 'class-ref' &&
  source.nativeBase !== undefined &&
  target.kind === 'keyed-collection' &&
  representationKey(source.nativeBase) === representationKey(target)

/**
 * Whether `target` is exactly the intrinsic promise `source`'s class extends
 * (`class-ref.nativeBase`): `timeout.then(...)` on `class Timeout extends
 * Promise<never>` reads `then` off that promise, sharing its state.
 */
export const isNativePromiseUpcast = (source: Representation, target: Representation): boolean =>
  source.kind === 'class-ref' &&
  source.nativeBase?.kind === 'promise' &&
  target.kind === 'promise' &&
  representationKey(source.nativeBase) === representationKey(target)

/** The materializer id every arm-view node carries; the printer dispatches its recipe on it. */
export const ARM_VIEW_MATERIALIZER = 'gea::host::armView'

/**
 * Whether `armViewFor` answers the pair: a sum some arm of which is a box or
 * an open Document, every other arm the target itself (or a Map the target's
 * all-dynamic view reads), read as a Map or an Array -- the collections a
 * Document can view (`gea::dictionary::aliasOf`). `emit-narrowing.ts`'s
 * `armViewText` renders exactly these arms.
 */
const isArmViewPair = (source: Representation, target: Representation): boolean => {
  if (source.kind !== 'tagged-union') return false
  const viewable = (target.kind === 'keyed-collection' && target.family === 'map') || target.kind === 'array-object'
  if (!viewable || target.ownership !== 'shared-refcount') return false
  const key = representationKey(target)
  const indirect = (arm: TaggedUnionArm): boolean => arm.value.kind === 'dynamic' || isOpenDocument(arm.value)
  // Another Map carrier is the same object read through the all-dynamic Map
  // view (`gea::detail::unboxDynamicMap`), when that is the target.
  const mapView = (arm: TaggedUnionArm): boolean =>
    target.kind === 'keyed-collection' &&
    target.key.kind === 'dynamic' &&
    target.value?.kind === 'dynamic' &&
    target.recursive === undefined &&
    target.readOnlyView !== true &&
    arm.value.kind === 'keyed-collection' &&
    arm.value.family === 'map' &&
    arm.value.recursive === undefined &&
    arm.value.ownership === 'shared-refcount'
  return source.arms.some(indirect) && source.arms.every((arm) => indirect(arm) || representationKey(arm.value) === key || mapView(arm))
}

/** The materializer id every asserted-union node carries; the printer dispatches its recipe on it. */
export const ASSERTED_UNION_MATERIALIZER = 'gea::host::assertedUnion'

/** The asserted-union node that may rebuild an `Array<any>` arm as a copy. */
export const ASSERTED_UNION_COPY_MATERIALIZER = 'gea::host::assertedUnionCopy'

/** The materializer id every asserted-view node carries; the printer dispatches its recipe on it. */
export const ASSERTED_VIEW_MATERIALIZER = 'gea::host::assertedView'

/** A structural record carrier: a value that can be a view of a class allocation only through its origin. */
export const isStructuralRecordCarrier = (value: Representation): boolean =>
  value.kind === 'record' || value.kind === 'record-with-index' || (value.kind === 'native-record-ref' && value.native === null)

/** One class an asserted record's origin may be, and the certified load of that allocation into the target. */
export interface AssertedViewArm {
  readonly declaration: DeclarationId
  readonly load: ConversionNode
}

/**
 * `assertedViewFor`'s plan. `views` is false for an owned record, which has no
 * origin allocation, so `arms` is then empty and every present value fails the
 * assertion. `arms` is in origin-test order (`assertedViewClassArmsOf`);
 * `absent` converts the optional source's absence.
 */
export interface AssertedViewPlan {
  readonly views: boolean
  readonly arms: readonly AssertedViewArm[]
  readonly absent: ConversionNode | null
}

/**
 * The shared class arms an asserted record may be a view of, in the order the
 * origin test must try them: a descendant before its base, so an allocation
 * of the derived class selects its own arm.
 */
export const assertedViewClassArmsOf = (target: Representation): readonly Extract<Representation, { kind: 'class-ref' }>[] => {
  const present = target.kind === 'optional' ? target.payload : target
  const leaves = present.kind === 'tagged-union' ? present.arms.map((arm) => arm.value) : [present]
  const classes = leaves.filter(
    (leaf): leaf is Extract<Representation, { kind: 'class-ref' }> => leaf.kind === 'class-ref' && leaf.ownership === 'shared-refcount'
  )
  // Every other present leaf must be one no record can be: a primitive.
  const primitive = (leaf: Representation): boolean =>
    leaf.kind === 'scalar' || leaf.kind === 'string' || leaf.kind === 'symbol' || leaf.kind === 'undefined' || leaf.kind === 'null'
  if (!leaves.every((leaf) => (leaf.kind === 'class-ref' ? leaf.ownership === 'shared-refcount' : primitive(leaf)))) return []
  return [...classes].sort((left, right) => right.ancestors.length - left.ancestors.length)
}

/** The materializer id every exact-arm node carries; the printer dispatches its recipe on it. */
export const EXACT_ARM_MATERIALIZER = 'gea::host::exactArm'

/**
 * Which arm of `source` the target IS, by carrier key, or `null` when the
 * source is not a tagged union or no single arm matches. A union's arms are
 * pairwise disjoint at runtime, so two arms never share a key; the
 * exactly-one test still guards the answer rather than trusting that.
 */
export const exactArmIndexOf = (source: Representation, target: Representation): number | null => {
  // A possibly-absent union projects the same way; absence fails the check
  // like any other arm (`gea::host::exactArm`'s `Optional` overload).
  if (source.kind === 'optional' && source.payload.kind === 'tagged-union') return exactArmIndexOf(source.payload, target)
  if (source.kind !== 'tagged-union') return null
  const targetKey = representationKey(target)
  const matches = source.arms.flatMap((arm, index) => (representationKey(arm.value) === targetKey ? [index] : []))
  return matches.length === 1 ? (matches[0] ?? null) : null
}
