import {
  nativeCallableReadonlySetsOf,
  nativeCallableReadonlySetMatches,
  type NativeCallableReadonlySet
} from './native-callable-readonly-set.js'
import { lexicalReceiverOriginMatches } from './native-logical-receiver-body.js'
import { constantPropertyKeyTextOf } from './native-property-key-texts.js'
import type { NativeCallableDataPlan } from '../representation/native-callable-data-storage.js'
import { deadLogicalMergeValueMatches } from './dead-logical-merge.js'
import {
  ordinaryFunctionDataWriteMatches,
  nativeCallablePrivateSlotsOf,
  nativeCallablePrivateSlotMatches,
  type NativeCallablePrivateSlot
} from './native-callable-own-property.js'
import { nativeIteratorLogicalReceiverAdmitted } from './native-iterator-receivers.js'
import { nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import {
  fixedDataDefinitionCallMatches,
  fixedDataDefinitionUsesNativeField,
  type FixedDataDefinitionRecipe
} from './fixed-data-definition.js'
import { fixedDataDefinitionAttributesOf } from './fixed-data-definition-attributes.js'
import { nativeDataDefinitionOf, nativeDataDefinitionMatches } from './native-data-definition.js'
import { nativeObjectSampleMatches } from './native-object-sample.js'
import { nativeOwnAssignmentLayoutOf, nativeOwnAssignmentRecipeOf, nativeOwnAssignmentRecipesMatch } from './native-own-assignment.js'
import {
  nativeAccessorDefinitionOf,
  nativeAccessorDefinitionMatches,
  nativeAccessorObservationOf,
  nativeAccessorObservationMatches,
  nativeAccessorObservationNeedsReceipt,
  nativeAccessorReinstallationOf,
  nativeAccessorReinstallationMatches
} from './native-accessor-definition.js'
import { nativeCallableDataSlotsOf, nativeCallableDataSlotMatches, type NativeCallableDataSlot } from './native-callable-data-slots.js'
import { nativeCallableDataOwnerAt, nativeCallableDataStorageRequiresAuthorityAt } from '../projection/native-callable-data.js'
import { nativeCallableDataWritesOf, nativeCallableDataWriteMatches, type NativeCallableDataWrite } from './native-callable-data-write.js'
import { nativeCallableTypedDataReadRequiresAuthority, nativeCallableUninstalledKeyOf } from './native-callable-data-reads.js'
import { nativeCallableIntegrityAuthorityOf, nativeCallableIntegrityMatches } from './native-callable-integrity.js'
import {
  nativeCallablePrototypeDescriptorsOf,
  nativeCallablePrototypeMatches,
  nativeCallablePrototypeObservationsOf,
  nativeCallablePrototypeReadsOf
} from './native-callable-prototype.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import type { DeclarationId, FunctionId, IrValueId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'
import { nativeArrayViewPlanMatches } from '../conversion/array-view.js'
import { nativeDescriptorSnapshotPlanMatches } from '../conversion/native-descriptor-snapshot.js'
import { nativeArrayDescriptorSnapshotMatches, nativeArrayDescriptorReinstallationOf } from './native-array-descriptor-snapshot.js'
import { operationOfResult } from '../identity/ids.js'
import type { TargetRuntimeManifest } from '../preflight/obligations.js'
import type { ClassLayout } from '../projection/classes.js'
import { classFamilyMayAllocate, classMethodFamilyHasNativeBody } from '../projection/dispatch.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { forEachEmbeddedRepresentation } from '../representation/embedded-carriers.js'
import { captureCapabilityOf, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { DeadTypeofGuardCensus } from '../semantics/normalize/dead-typeof-guards.js'
import { propertyAccessKeysOf } from './certify/property-access.js'
import { runtimeHelperKeysOf } from './certify/runtime-helper.js'
import { parallelRegionRefusalsOf } from './certify/parallel-region.js'
import type { IrLoweringBlocker } from './lower.js'
import type { SlotDrift } from './lower-operands.js'
import { allOperationsOf, type CallOperation, type GetOperation, type IrBody, type IrOperation, type SetOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'
import type { PhysicalBodyId } from '../identity/ids.js'
import type { Refusal } from './refusal.js'
import { nativeMergeTransportMatches } from './native-merge-transport.js'
import { nativeOrdinaryAllocationMatches } from './native-property-presence-effects.js'
import { mergeConversionPlanMatches } from './merge-conversions.js'
import { convertCarriersOf } from './convert-carriers.js'
import { bufferReadNeedsLogicalReceiver, hostReadIgnoresLogicalReceiver, nativeLogicalReceiverAdmitted } from './logical-receivers.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { nativeFieldOwnerReadMatches } from './native-field-owner.js'
import { absentClassArmsHold } from './absent-class-arm.js'
import type { ReflectionExposure } from './reflection-demand.js'
import { objectValueConversionInputsOf, objectValueConversionsMatch } from './object-value-conversions.js'
import { operationConversionInputsOf, operationConversionsMatch } from './operation-conversions.js'
import { methodConversionInputsOf, methodValueRecipesMatch } from './publish-conversion-recipes.js'
import { denseLoopConversionsOf, denseLoopPlanMatches } from './dense-loops.js'
import { hostNamespaceReadsOf, hostNamespaceCensusMatches, type HostNamespaceCensus } from './host-namespace-reads.js'
import type { HostSpellings } from '../targets/cpp/host/host-members.js'
import { programConversionInputsOf, programConversionRecipesMatch, type ProgramConversionRecipe } from './program-conversions.js'
import { spreadCopyConversionPlanMatches } from './spread-conversions.js'
import { hostObjectWalkPlanMatches, nativeArrayDescriptorSnapshotRequired } from './host-template-conversions.js'
import { nativeCallableSourceMatches } from './native-callable-argument.js'
import {
  authenticatedNativeHostMethodReadOf,
  intrinsicCallFlagsMatch,
  nativeHostMethodReadMatches,
  type AuthenticatedNativeHostMethodRead
} from './intrinsic-call-facts.js'
import { plannedHostTemplateOf } from '../projection/callee.js'
import { nativeHostMethodReadProofsOf } from './native-host-method-reads.js'
import { nativeUnionMethodTargetMatches } from './native-union-method-targets.js'
import { createReadOnlyDictionaryAuthority } from './read-only-dictionary.js'
import { abiOfCallee, type CalleeRenderingInput } from '../projection/callee.js'
import { buildHostMethodAliasIndex, type HostMethodAlias } from './host-method-aliases.js'
import { callableOriginsOf } from '../semantics/callable-origins.js'
import { settledVirtualCallFramesOf } from './virtual-call-frames.js'
import { nonNormalReceiverProofMatches } from './non-normal-receiver.js'
import {
  nativeFieldViewLivePlansOf,
  nativeFieldViewTargetSetOf,
  nativeFieldViewDocumentTargetSetOf,
  nativeFieldViewOpenDocumentRead,
  nativeFieldViewOpenReadOf,
  nativeFieldViewCarrierNeedsReceipt,
  nativeFieldViewOperationNeedsReceipt,
  nativeFieldViewReadOf,
  nativeFieldViewWriteOf,
  nativeFieldViewReadSelectionOf,
  nativeFieldViewWriteSelectionOf,
  nativeFieldViewReceiptMatches
} from './native-field-view-facts.js'
import { computedPropertyKeyTextsOf } from './typed-property-access.js'
import { nativeObjectDataSlotAuthorityOf, nativeObjectDataSlotMatches, type NativeObjectDataSlot } from './native-object-data-slots.js'
import { nativeIteratorFieldReadOf, nativeIteratorFieldReadMatches, type NativeIteratorFieldRead } from './native-iterator-field-views.js'
import { nativeEntryFieldReadsMatch, nativeEntryFieldReadsOf, nativeEntryFieldReadsRequired } from './native-entry-field-views.js'
import { nativePropertyPrototypeAbsenceMatches } from './native-property-presence.js'
import { nativeDocumentEntryOf, nativeDocumentEntryMatches } from './native-document-entries.js'

/**
 * Certification of the lowered IR.
 *
 * Preflight certified a program by predicting, from the semantic graph and
 * the plan, what lowering and the printer would do with it: seven builders
 * re-derived slots, receivers and key literalness so they could ask the
 * manifest the question the printer would later ask. This walks the IR that
 * lowering actually built. Every operation states its operands' carriers,
 * every `convert` cites the census node it applies, every allocation names
 * its captures -- so each capability the printer will need is a function of
 * the operation alone, spelled once here in the manifest's own vocabulary
 * and looked up in the manifest's own sets. The certificate is the empty
 * refusal list.
 *
 * One namespace. A key is `${family}:${discriminator}`; the family names the
 * manifest set the discriminator is a member of (`property-access` ->
 * `propertyRecipes`, `runtime-helper` -> `runtimeHelpers`, ...), or the
 * census that answers it (`conversion` -> the conversion census by node id).
 * A refusal anywhere in the compiler that names a key outside this union is
 * a type error, which is what closes the gap `scripts/refusal-keys.mjs`
 * measures.
 */

export const capabilityFamilies = [
  'physical-cpp-type',
  'call-abi',
  'host-invocation',
  'host-member-call',
  'property-access',
  'capture',
  'conversion',
  'native-boundary',
  'runtime-helper',
  'abrupt-edge',
  'parallel-region'
] as const

export type CapabilityFamily = (typeof capabilityFamilies)[number]
export type CapabilityKey = `${CapabilityFamily}:${string}`

export type CapabilityVerdict = 'installed' | 'missing' | 'unsupported'

/**
 * One capability an operation needs. `verdict` is stated by the family only
 * for a capability the manifest publishes no set for -- a physical type,
 * which is a predicate over a carrier rather than a member of a finite set,
 * or an `Atomics` member whose admissible argument shapes the target decides
 * by rule. Every other demand is decided by `verdictOf` from the key alone.
 */
export interface CapabilityDemand {
  readonly key: CapabilityKey
  readonly verdict?: CapabilityVerdict
  /** Why, when the family already knows the verdict is not `installed`. */
  readonly detail?: string
}

export interface CertifyInput {
  readonly programConversionRecipes?: readonly ProgramConversionRecipe[]
  readonly representations?: readonly Representation[]
  readonly hosts?: HostSpellings
  readonly wellKnownSymbols?: ReadonlyMap<DeclarationId, string>
  readonly abis?: ReadonlyMap<FunctionId, CallableAbi>
  readonly calleeRendering?: CalleeRenderingInput
  readonly reflection?: ReflectionExposure
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  /**
   * Where each declaration's cell physically lives, which is the only place a
   * CAPTURED declaration's carrier is stated -- a capture names a cell, not an
   * SSA value, so the body's own value index cannot answer what it carries.
   */
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /**
   * The slots lowering could not fill (`LoweringProgram.drift`). Each is a
   * (source, slot) pair the census answered `never` for, handed through
   * unconverted so the printer's own chain could try -- the transition
   * the move of program facts into the IR licensed. Certification does not
   * license it: an operand in a carrier its slot does not hold is a missing
   * conversion whatever the printer later manages, and it is refused here by
   * the pair's own key so the census gap is named where it can be closed.
   */
  readonly slotDrift: readonly SlotDrift[]
  /**
   * The bodies lowering could not build (`IrLoweringResult.blocked`). They
   * are not in `bodies`, so the walk never sees them; a program with one is
   * not certified, whatever the walk found in the bodies that did lower.
   * The rows themselves stay `lower`-stage refusals (`refusalsOf`), not
   * duplicated here.
   */
  readonly blocked: readonly IrLoweringBlocker[]
  readonly manifest: TargetRuntimeManifest
  readonly conversions: ConversionCensus
  readonly deriver: RepresentationDeriver
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Ambient value declarations rendered as `extern` references (`frontend.externalBindings`). */
  readonly externalBindings: ReadonlySet<DeclarationId>
  /**
   * The host functions the plugins run as parallel regions
   * (`PluginCapabilities.parallelRegionEntries`). Absent for a program no
   * plugin gives a region.
   */
  readonly parallelRegionEntries?: ReadonlySet<string>
  /**
   * Display only: how a parallel-region refusal names a variable and places
   * its site, so a user reads `total` at `main.ts:12:5` rather than identities.
   */
  readonly parallelRegionSource?: {
    readonly nameOfDeclaration: (declaration: DeclarationId) => string | null
    readonly locationOfLineage: (lineage: SemanticResultId) => string | null
  }
  readonly deadTypeofGuards: DeadTypeofGuardCensus
  /**
   * The semantic graph, reached only through `operationOfResult(lineage)`.
   * Two whole-program facts the property families need (a callable's
   * `.call`/`.apply`/`.bind` resolution, a class's lifecycle census) are still
   * derived from the graph rather than carried on the IR; Phase 3's
   * `CallOperation.target` moves the first onto the operation, and this
   * field goes with it.
   */
  readonly graph: SemanticGraph
  /** The published callable own-data storage (`RepresentationPublication`). */
  readonly nativeCallableData: NativeCallableDataPlan
}

/** What the families see: the whole-program inputs plus the body being walked. */
export interface CertifyContext extends CertifyInput {
  readonly fixedDataDefinitionAttributes?: ReadonlyMap<CallOperation, FixedDataDefinitionRecipe>
  readonly nativeHostMethodReads?: ReadonlyMap<IrOperation, AuthenticatedNativeHostMethodRead>
  readonly nativeFieldViews?: ReturnType<typeof nativeCallableFlowOf>
  readonly nativeFieldViewTargets?: ReadonlySet<string>
  /** `nativeFieldViewDocumentTargetSetOf`: targets reached only through installed Document views. */
  readonly nativeFieldViewDocumentTargets?: ReadonlySet<string>
  readonly nativeFieldViewPlans?: readonly import('../conversion/native-field-view.js').NativeFieldViewPlan[]
  readonly privateNativeCallableSlots?: ReadonlyMap<IrOperation, NativeCallablePrivateSlot>
  readonly nativeCallableDataSlots?: ReadonlyMap<IrOperation, NativeCallableDataSlot>
  readonly nativeCallableReadonlySets?: ReadonlyMap<SetOperation, NativeCallableReadonlySet>
  readonly nativeCallableDataWrites?: ReadonlyMap<IrOperation, NativeCallableDataWrite>
  readonly nativeCallableIntegrity?: ReturnType<typeof nativeCallableIntegrityAuthorityOf>
  readonly nativeCallablePrototypes?: ReturnType<typeof nativeCallablePrototypeReadsOf>
  readonly nativeCallablePrototypeObservations?: ReturnType<typeof nativeCallablePrototypeObservationsOf>
  readonly nativeCallablePrototypeDescriptors?: ReturnType<typeof nativeCallablePrototypeDescriptorsOf>
  readonly nativeObjectDataSlots?: ReadonlyMap<IrOperation, NativeObjectDataSlot>
  readonly nativeObjectDataSlotCandidates?: ReadonlySet<IrOperation>
  readonly callableSources?: ReturnType<typeof nativeCallableFlowOf>['callables']
  readonly ignoredLogicalReceivers?: ReadonlySet<IrValueId>
  readonly readOnlyDictionary?: ReturnType<typeof createReadOnlyDictionaryAuthority>
  readonly hostMethodAliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
  readonly virtualFrames?: ReadonlyMap<string, CallableAbi>
  readonly authenticatedHosts?: HostNamespaceCensus
  readonly body: IrBody
  /** The operation that defines an SSA value in this body, so a family can ask whether a key is a constant. */
  readonly definitionOf: (value: IrValueId) => IrOperation | null
  readonly semanticOperationOf: (lineage: SemanticResultId) => SemanticOperation | null
  /** Whether the semantic operation this IR operation lowers sits in a proven-dead `typeof` guard consequent. */
  readonly isDead: (lineage: SemanticResultId) => boolean
}

export interface IrCertification {
  readonly certified: boolean
  readonly refusals: readonly Refusal[]
  /** Every key any operation demanded, deduplicated and sorted -- the census of what this program asks of the target. */
  readonly demanded: readonly CapabilityKey[]
}

export const familyOf = (key: CapabilityKey): CapabilityFamily => key.slice(0, key.indexOf(':')) as CapabilityFamily
export const isCapabilityKey = (key: string): key is CapabilityKey =>
  (capabilityFamilies as readonly string[]).includes(key.slice(0, key.indexOf(':')))
const discriminatorOf = (key: CapabilityKey): string => key.slice(key.indexOf(':') + 1)

/**
 * Whether the target can spell a carrier. The manifest's `physicalTypes` set
 * is the plan's projection of the target's own predicate; the IR carries
 * carriers the plan never selected (a slot's carrier, a `convert`'s result),
 * so a manifest that publishes the predicate itself is asked directly, and
 * one that does not falls back to the set -- fail-closed, as every optional
 * manifest field reads when absent.
 */
const spellable = (manifest: TargetRuntimeManifest, representation: Representation): boolean =>
  manifest.spellable ? manifest.spellable(representation) : manifest.physicalTypes.has(representationKey(representation))

const physicalTypeDemand = (manifest: TargetRuntimeManifest, representation: Representation): CapabilityDemand => {
  const key = representationKey(representation)
  return spellable(manifest, representation)
    ? { key: `physical-cpp-type:${key}`, verdict: 'installed' }
    : { key: `physical-cpp-type:${key}`, verdict: 'missing', detail: `the target cannot spell ${key}` }
}

/** `native-handle` is admissible only behind a versioned, authenticated host protocol; the key is the target's own tag name where the host stated one. */
const nativeBoundaryDemand = (representation: Representation): CapabilityDemand | null =>
  representation.kind === 'native-handle'
    ? { key: `native-boundary:${representation.native ?? representation.protocol}@${representation.version}` }
    : null

/**
 * The native-boundary demands of every carrier a representation EMBEDS. The
 * root's own demand is `nativeBoundaryDemand`; this is the rest of the tree
 * -- the fields of a record, the arms of a union, a callable's signature --
 * because the emitted C++ spells all of it, and a `native-handle` a struct
 * field names must be as authenticated as one an SSA value holds. Asked of
 * the root alone, lib.dom's `Window` certified with `Navigator`/`History`
 * fields whose tag types no host declared, and clang was the first to say so.
 */
const embeddedNativeBoundaryDemands = (representation: Representation): CapabilityDemand[] => {
  const demands: CapabilityDemand[] = []
  forEachEmbeddedRepresentation(representation, (carrier) => {
    const boundary = nativeBoundaryDemand(carrier)
    if (boundary) demands.push(boundary)
  })
  return demands
}

const abiDemands = (manifest: TargetRuntimeManifest, abi: CallableAbi | null): CapabilityDemand[] => {
  if (abi === null) return []
  const carriers: Representation[] = [...abi.parameters.map((parameter) => parameter.value), abi.result]
  if (abi.receiver !== null) carriers.push(abi.receiver)
  return carriers.flatMap((carrier) => {
    const boundary = nativeBoundaryDemand(carrier)
    const embedded = embeddedNativeBoundaryDemands(carrier)
    return boundary ? [physicalTypeDemand(manifest, carrier), boundary, ...embedded] : [physicalTypeDemand(manifest, carrier), ...embedded]
  })
}

const getDemandsOf = (operation: Extract<IrOperation, { kind: 'get' }>, ctx: CertifyContext): CapabilityDemand[] => {
  if (operation.absentClassArms !== undefined) {
    const key = ctx.definitionOf(operation.key.value)
    if (
      !absentClassArmsHold(operation, key?.kind === 'constant' && key.literal === 'string' ? key.text : null, ctx.classes, ctx.reflection)
    )
      return [
        {
          key: 'property-access:union:get:absent-class-arm',
          verdict: 'missing',
          detail: 'an absent class arm is declared on its family or its class holds a dynamic protocol'
        }
      ]
  }
  if (operation.nativeFieldOwnerRead) {
    const key = ctx.definitionOf(operation.key.value)
    if (
      !nativeFieldOwnerReadMatches(
        operation,
        key?.kind === 'constant' && key.literal === 'string' ? key.text : null,
        ctx.classes,
        ctx.conversions,
        ctx.reflection
      )
    )
      return [
        {
          key: 'runtime-helper:native-field-owner-read',
          verdict: 'missing',
          detail: 'native field-owner read disagrees with its layout, exposure or conversions'
        }
      ]
    return [
      ...(operation.nativeFieldOwnerRead.arms.length > 0
        ? [{ key: 'runtime-helper:computation:instanceof:class-ref:constructor-family' as CapabilityKey }]
        : []),
      ...[operation.nativeFieldOwnerRead.missing, ...operation.nativeFieldOwnerRead.arms.map((arm) => arm.conversion)].map((id) => ({
        key: `conversion:${id}` as CapabilityKey
      }))
    ]
  }
  const recipe = operation.typedComputedRead
  if (recipe === undefined) return []
  const recipeKey: CapabilityKey = 'property-access:record:get:typed-computed-read'
  const demands: CapabilityDemand[] = []
  // The recipe's own `.receiver` key describes the PEELED (bare-record)
  // representation -- `typedComputedReadRecipeOf` (typed-property-access.ts)
  // peels one `optional` layer before building it, because a bounds-unchecked
  // array/tuple read (`arr[i]!`) is physically `optional` at this compiler's
  // representation layer regardless of the checker's static type, and `emitGet`
  // unwraps that wrapper (via `unwrapPresentValue`) before ever consulting a
  // recipe. This certification must compare against that same peeled shape, not
  // the raw (possibly still-`optional`) `operation.receiver.representation`, or
  // an otherwise-valid recipe built for exactly this operation is judged a
  // mismatch and refused here even though nothing about it actually disagrees.
  const peeledReceiver =
    operation.receiver.representation.kind === 'optional' ? operation.receiver.representation.payload : operation.receiver.representation
  if (
    recipe.receiver !== representationKey(peeledReceiver) ||
    recipe.result !== representationKey(operation.result.representation) ||
    (recipe.receiverBounded !== undefined && recipe.receiverBounded.carrier !== representationKey(operation.key.representation)) ||
    recipe.arms.length === 0
  ) {
    demands.push({
      key: recipeKey,
      verdict: 'missing',
      detail: 'the sealed computed-read recipe does not match the get operation carriers'
    })
  }
  if (recipe.receiverBounded !== undefined) {
    const node = ctx.conversions.nodeById(recipe.receiverBounded.missing)
    const key = `conversion:${recipe.receiverBounded.missing}` as CapabilityKey
    if (node !== null && (node.source.kind !== 'undefined' || representationKey(node.target) !== recipe.result))
      demands.push({ key, verdict: 'missing', detail: 'the numeric computed-read absence conversion does not match its result' })
    else demands.push({ key })
  }
  for (const arm of recipe.arms) {
    if (arm.absent !== undefined) {
      const absentKey = `conversion:${arm.absent}` as CapabilityKey
      const absent = ctx.conversions.nodeById(arm.absent)
      if (absent !== null && (absent.source.kind !== 'undefined' || representationKey(absent.target) !== recipe.result))
        demands.push({
          key: absentKey,
          verdict: 'missing',
          detail: `the absence conversion for field "${arm.key}" does not match its result`
        })
      else demands.push({ key: absentKey })
    }
    const key = `conversion:${arm.conversion}` as CapabilityKey
    const node = ctx.conversions.nodeById(arm.conversion)
    if (
      node !== null &&
      (representationKey(node.source) !== representationKey(arm.source) ||
        representationKey(node.target) !== representationKey(operation.result.representation))
    ) {
      demands.push({
        key,
        verdict: 'missing',
        detail: `the sealed conversion for field "${arm.key}" does not match the computed-read recipe`
      })
    } else {
      // The conversion census remains the authority for existence and
      // capability. The emitter receives only this authenticated node id.
      demands.push({ key })
    }
  }
  return demands
}

/**
 * A `[[Get]]` on a genuinely dynamic receiver -- or on a constructor carried
 * by its ABI alone, whose members are read as the same boxed values
 * (`constructorValueDispatchGetText`) -- whose result this operation
 * publishes as a concrete carrier: the boxed value `getProperty` answers has
 * to be converted into that carrier, and `emit-dynamic-properties.ts`'s
 * `dynamicGetText` renders exactly that conversion. It is demanded here
 * because nothing else did -- a read converted into a callable whose result
 * is an iterator certified, and then failed as a C++ template
 * (`DynamicCarrier<Iterator<...>>` has no checked `in`), where the same pair
 * reached through a `convert` op is refused by name
 * (`functionValueDispatchMaterializer`). The conversion census is the one
 * authority on the pair; the source is the box `getProperty` produces.
 */
const dynamicGetResultDemandsOf = (operation: Extract<IrOperation, { kind: 'get' }>, ctx: CertifyContext): CapabilityDemand[] => {
  const receiver = operation.receiver.representation.kind
  if (receiver !== 'dynamic' && receiver !== 'constructor-value-dispatch') return []
  const produced = operation.result.representation
  if (produced.kind === 'dynamic') return []
  const node = ctx.conversions.nodeFor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, produced)
  return [{ key: `conversion:${node.id}` as CapabilityKey }]
}

/**
 * The demands this module derives itself: the ones whose fact is a single
 * field of the operation. The property families and the runtime-helper
 * families each live in their own module because their key spellings are
 * refinements of a carrier (`iterator(next):get:false`,
 * `protocol:spread:dictionary(string->record)`) that the manifest's tables
 * spell the same way, and that vocabulary is one subject per module.
 */
const ownDemandsOf = (operation: IrOperation, ctx: CertifyContext): CapabilityDemand[] => {
  switch (operation.kind) {
    case 'dead-logical-merge-value':
      return deadLogicalMergeValueMatches(
        operation,
        ctx.semanticOperationOf(operation.lineage),
        ctx.body,
        ctx.semanticOperationOf,
        ctx.conversions
      )
        ? []
        : [
            {
              key: 'runtime-helper:dead-logical-merge-value:source-proof',
              verdict: 'missing',
              detail: 'a dead logical value lacks its exact source object fact and controlling falsy edge'
            }
          ]
    case 'merge-live-arm-rebuild': {
      const plan = operation.mergeConversionPlan
      if (!mergeConversionPlanMatches(operation, ctx.semanticOperationOf(operation.lineage), ctx.conversions, ctx.definitionOf, ctx.body))
        return [
          {
            key: 'runtime-helper:merge-live-arm-rebuild:conversion-plan',
            verdict: 'missing',
            detail: 'merge arm recipes disagree with the authenticated control-flow split and finalized SSA homes'
          }
        ]
      const demands: CapabilityDemand[] = [
        ...plan!.arms.map((arm) => ({ key: `conversion:${arm.conversion}` as CapabilityKey })),
        ...(plan!.absence ? [{ key: `conversion:${plan!.absence}` as CapabilityKey }] : [])
      ]
      const source = operation.source.representation
      const payload = source.kind === 'optional' ? source.payload : source
      if (payload.kind === 'tagged-union')
        for (const arm of plan!.arms)
          if (arm.mode === 'truthiness')
            demands.push({ key: `runtime-helper:conversion:to-boolean:${payload.arms[arm.index]!.value.kind}` })
      const recipe = operation.nativeTransport
      if (!recipe) return demands
      if (!nativeMergeTransportMatches(operation, ctx.conversions))
        return [
          {
            key: 'runtime-helper:merge-live-arm-rebuild:native-transport',
            verdict: 'missing',
            detail: 'native merge transport disagrees with its live arms or conversion nodes'
          }
        ]
      return [
        ...demands,
        ...recipe.arms.map((arm) => ({ key: `conversion:${arm.conversion}` as CapabilityKey })),
        ...(recipe.absence ? [{ key: `conversion:${recipe.absence}` as CapabilityKey }] : [])
      ]
    }
    case 'convert': {
      const conversion = ctx.conversions.nodeById(operation.conversionUse)
      if (
        operation.nativeObjectSample !== undefined ||
        (conversion?.capability.kind === 'static' && conversion.capability.materializer.nativeObjectSample !== undefined)
      ) {
        const block = [...ctx.body.blocks.values()].find((block) => block.operations.includes(operation))
        const before = block?.operations.slice(0, block.operations.indexOf(operation)) ?? []
        if (
          !ctx.calleeRendering ||
          !nativeObjectSampleMatches(operation, before, {
            graph: ctx.graph,
            deriver: ctx.deriver,
            conversions: ctx.conversions,
            placements: ctx.placements,
            selected: ctx.calleeRendering.plan.selected,
            calleeRendering: ctx.calleeRendering
          })
        )
          return [
            {
              key: `conversion:${operation.conversionUse}`,
              verdict: 'missing',
              detail:
                'a native object sample lacks its exact source allocation, complete stored-value family or normal-path installing copy'
            }
          ]
      }
      if (
        operation.nativeCallableSource !== undefined &&
        !nativeCallableSourceMatches(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          ctx.definitionOf(operation.source.value),
          callableOriginsOf(ctx.graph),
          ctx.abis ??
            new Map([...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))),
          ctx.conversions,
          ctx.graph,
          ctx.calleeRendering === undefined
            ? undefined
            : {
                graph: ctx.graph,
                classes: ctx.classes,
                representations: ctx.calleeRendering.plan.selected,
                abis:
                  ctx.abis ??
                  new Map(
                    [...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))
                  )
              }
        )
      )
        return [
          {
            key: `conversion:${operation.conversionUse}`,
            verdict: 'missing',
            detail: 'a native callable value frame disagrees with its authenticated source Function'
          }
        ]
      // The exact cited node decides the pair; rejected conversions stop here.
      const node = ctx.conversions.nodeById(operation.conversionUse)
      if (
        node?.capability.kind === 'static' &&
        node.capability.materializer.readOnlyDictionary !== undefined &&
        (operation.rebuild !== undefined ||
          ctx.conversions.readOnlyDictionaryFor(operation.source.representation, operation.result.representation) !== node ||
          ctx.readOnlyDictionary?.matches(operation.result.id, operation.readOnlyDictionaryProof) !== true)
      )
        return [
          {
            key: `conversion:${operation.conversionUse}`,
            verdict: 'missing',
            detail: 'a contextual dictionary reader has an unproved mutation or escape'
          }
        ]
      const carriers = convertCarriersOf(operation)
      return carriers === null ||
        (node !== null &&
          (representationKey(node.source) !== representationKey(carriers.source) ||
            representationKey(node.target) !== representationKey(carriers.target)))
        ? [
            {
              key: `conversion:${operation.conversionUse}`,
              verdict: 'missing',
              detail: 'a conversion instruction names a node for different carriers'
            }
          ]
        : [
            { key: `conversion:${operation.conversionUse}` },
            ...(operation.nativeObjectSample?.fields.flatMap((field) =>
              field.storageFits.map((fit) => ({ key: `conversion:${fit.conversion}` as CapabilityKey }))
            ) ?? [])
          ]
    }
    case 'call':
    case 'construct': {
      const demands: CapabilityDemand[] = [{ key: 'call-abi:generic' }]
      const noNormal =
        operation.kind === 'call' &&
        operation.nonNormalReceiverProof !== undefined &&
        nonNormalReceiverProofMatches(operation, {
          body: ctx.body,
          bodies: ctx.bodies.values(),
          conversions: ctx.conversions,
          callables: ctx.callableSources ?? new Map(),
          definitionOf: ctx.definitionOf,
          semantic: ctx.semanticOperationOf(operation.lineage),
          semanticOperationOf: ctx.semanticOperationOf
        })
      if (operation.kind === 'call' && operation.nonNormalReceiverProof !== undefined) {
        if (!noNormal)
          demands.push({
            key: 'call-abi:logical-receiver',
            verdict: 'missing',
            detail: 'a non-normal Proxy receiver receipt does not authenticate its exact trap path and actual call frame'
          })
        else for (const id of operation.nonNormalReceiverProof.conversions) demands.push({ key: `conversion:${id}` })
      }
      if (
        operation.kind === 'call' &&
        !noNormal &&
        !nativeLogicalReceiverAdmitted(operation, ctx.ignoredLogicalReceivers ?? new Set()) &&
        // The canonical host census names the actual callee SSA and its
        // installed free-function spelling. Its namespace owner is a path,
        // so this entry never consumes an erased JavaScript this-argument.
        !ctx.authenticatedHosts?.functionReads.has(operation.callee.value) &&
        !authenticatedTemplateCallEntry(operation, ctx.semanticOperationOf(operation.lineage), ctx.calleeRendering, ctx.definitionOf)
      ) {
        demands.push({
          key: 'call-abi:logical-receiver',
          verdict: 'unsupported',
          detail: 'a native logical receiver has no supported erased receiver protocol; its target is unknown or consumes this'
        })
      }
      let nativeDataDefinitionValid = false
      let nativeAccessorDefinitionValid = false
      let nativeAccessorReinstallationValid = false
      let nativeArrayDescriptorReinstallationValid = false
      if (operation.kind === 'call' && operation.nativeArrayDescriptorReinstallation) {
        const expected = ctx.nativeFieldViews
          ? nativeArrayDescriptorReinstallationOf(operation, ctx.definitionOf, ctx.nativeFieldViews, {
              bodies: ctx.bodies,
              placements: ctx.placements,
              classes: ctx.classes,
              conversions: ctx.conversions,
              deriver: ctx.deriver,
              calleeRendering: ctx.calleeRendering,
              ...(ctx.hostMethodAliases ? { hostMethodAliases: ctx.hostMethodAliases } : {})
            })
          : null
        nativeArrayDescriptorReinstallationValid =
          expected !== null && JSON.stringify(expected) === JSON.stringify(operation.nativeArrayDescriptorReinstallation)
        if (!nativeArrayDescriptorReinstallationValid)
          demands.push({
            key: 'runtime-helper:native-array-descriptor-snapshot',
            verdict: 'missing',
            detail: 'native array reinstallation has no unchanged copied descriptor and authenticated original owner'
          })
      }
      if (
        operation.kind === 'call' &&
        !operation.nativeAccessorObservation &&
        nativeAccessorObservationNeedsReceipt(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          {
            graph: ctx.graph,
            bodies: ctx.bodies,
            abis:
              ctx.abis ??
              new Map([...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))),
            conversions: ctx.conversions,
            calleeRendering: ctx.calleeRendering
          },
          ctx.definitionOf
        )
      )
        demands.push({
          key: 'call-abi:object-value-conversions',
          verdict: 'missing',
          detail: 'a reflected native accessor needs its original Function view receipt'
        })
      if (operation.kind === 'call' && operation.nativeAccessorReinstallation) {
        const expected = nativeAccessorReinstallationOf(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          {
            graph: ctx.graph,
            bodies: ctx.bodies,
            abis:
              ctx.abis ??
              new Map([...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))),
            conversions: ctx.conversions,
            calleeRendering: ctx.calleeRendering
          },
          ctx.definitionOf
        )
        nativeAccessorReinstallationValid = nativeAccessorReinstallationMatches(expected, operation.nativeAccessorReinstallation)
        if (!nativeAccessorReinstallationValid)
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'native accessor reinstallation lacks its unchanged exact source descriptor snapshot'
          })
      }
      if (operation.kind === 'call' && operation.nativeAccessorObservation) {
        const expected = nativeAccessorObservationOf(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          {
            graph: ctx.graph,
            bodies: ctx.bodies,
            abis:
              ctx.abis ??
              new Map([...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))),
            conversions: ctx.conversions,
            calleeRendering: ctx.calleeRendering
          },
          ctx.definitionOf
        )
        if (!nativeAccessorObservationMatches(expected, operation.nativeAccessorObservation))
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'native accessor reflection lacks its exact current definition, owner or original Function frame'
          })
        for (const half of operation.nativeAccessorObservation.halves) demands.push({ key: `conversion:${half.conversion}` })
      }
      if (operation.kind === 'call' && operation.nativeAccessorDefinition) {
        const expected = nativeAccessorDefinitionOf(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          {
            graph: ctx.graph,
            bodies: ctx.bodies,
            abis:
              ctx.abis ??
              new Map([...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))),
            conversions: ctx.conversions,
            calleeRendering: ctx.calleeRendering
          },
          ctx.definitionOf
        )
        nativeAccessorDefinitionValid = nativeAccessorDefinitionMatches(expected, operation.nativeAccessorDefinition)
        if (!nativeAccessorDefinitionValid)
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'native accessor definition disagrees with its complete descriptor writers or actual source Function frame'
          })
        for (const half of operation.nativeAccessorDefinition.halves) {
          demands.push({ key: `conversion:${half.conversion}` })
          if (half.observe !== null) demands.push({ key: `conversion:${half.observe}` })
        }
      }
      if (operation.kind === 'call') {
        const semantic = ctx.semanticOperationOf(operation.lineage)
        const receiver = operation.arguments[0]
        const carried = operation.arguments[2]?.representation
        // A descriptor literal carried by reference states the same own
        // accessor fields through its canonical layout; it cannot escape the
        // typed getter/setter installation demand.
        const descriptor =
          carried?.kind === 'native-record-ref' && carried.native === null
            ? ctx.deriver.layoutOf(carried.shapeId as StructuralTypeId)
            : carried
        const value = carried?.kind === 'record' ? carried.fields.find((field) => field.key === 'value') : undefined
        if (
          semantic?.family === 'invocation' &&
          semantic.intrinsicMutation === 'object-define-property' &&
          descriptor?.kind === 'record' &&
          descriptor.fields.some(
            (field) =>
              (field.key === 'get' || field.key === 'set') &&
              abiOfCallee(field.value.kind === 'optional' ? field.value.payload : field.value) !== null
          ) &&
          !nativeAccessorDefinitionValid &&
          !nativeAccessorReinstallationValid &&
          !nativeArrayDescriptorReinstallationValid
        )
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'a typed getter or setter descriptor requires an exact native Function installation receipt'
          })
        if (
          semantic?.family === 'invocation' &&
          semantic.intrinsicMutation === 'object-define-property' &&
          receiver &&
          value?.required &&
          value.value.kind !== 'dynamic' &&
          nativeFieldViewCarrierNeedsReceipt(receiver.representation, ctx.nativeFieldViewTargets ?? new Set()) &&
          !operation.nativeDataDefinition
        )
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'a typed data definition on a live view needs an exact native descriptor delegation receipt'
          })
      }
      if (operation.kind === 'call' && operation.nativeDataDefinition) {
        const expected = nativeDataDefinitionOf(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          {
            graph: ctx.graph,
            bodies: ctx.bodies,
            classes: ctx.classes,
            deriver: ctx.deriver,
            conversions: ctx.conversions,
            calleeRendering: ctx.calleeRendering
          },
          ctx.definitionOf
        )
        nativeDataDefinitionValid = nativeDataDefinitionMatches(expected, operation.nativeDataDefinition)
        if (!nativeDataDefinitionValid)
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'native data definition does not authenticate its actual receiver, descriptor and destination fields'
          })
        demands.push({ key: `conversion:${operation.nativeDataDefinition.conversion}` })
        if (operation.nativeDataDefinition.materialization !== undefined)
          demands.push({ key: `conversion:${operation.nativeDataDefinition.materialization}` })
      }
      if (operation.kind === 'call' && operation.objectValueConversions) {
        const semantic = ctx.semanticOperationOf(operation.lineage)
        const expected = objectValueConversionInputsOf(
          semantic?.family === 'invocation' ? semantic.intrinsicMutation : undefined,
          operation.arguments,
          ctx.deriver
        ).filter(
          (value) =>
            (value.role !== 'descriptor-value' ||
              value.argument !== 2 ||
              ((!nativeDataDefinitionValid || value.field !== 'value') &&
                (!nativeAccessorDefinitionValid ||
                  !operation.nativeAccessorDefinition!.halves.some((half) => half.half === value.field)))) &&
            !nativeAccessorReinstallationValid &&
            !nativeArrayDescriptorReinstallationValid
        )
        if (operation.argumentsAreSpread || !objectValueConversionsMatch(expected, operation.objectValueConversions, ctx.conversions))
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'Object value conversions do not match the authenticated field sources'
          })
        for (const value of operation.objectValueConversions) demands.push({ key: `conversion:${value.conversion}` })
      }
      if (
        operation.kind === 'call' &&
        !operation.fixedDataDefinition &&
        !operation.nativeDataDefinition &&
        !operation.nativeAccessorDefinition &&
        !operation.nativeAccessorReinstallation &&
        fixedDataDefinitionUsesNativeField(
          operation,
          ctx.semanticOperationOf(operation.lineage),
          ctx.deriver,
          ctx.classes,
          ctx.definitionOf
        )
      )
        demands.push({
          key: 'call-abi:fixed-data-definition',
          verdict: 'missing',
          detail: 'a native fixed field definition has no authenticated descriptor recipe'
        })
      if (operation.kind === 'call' && operation.fixedDataDefinition) {
        const recipe = operation.fixedDataDefinition
        const semantic = ctx.semanticOperationOf(operation.lineage)
        const node = recipe.conversion === null ? null : ctx.conversions.nodeById(recipe.conversion)
        if (
          (operation.arguments[0] &&
            nativeFieldViewCarrierNeedsReceipt(operation.arguments[0].representation, ctx.nativeFieldViewTargets ?? new Set())) ||
          !fixedDataDefinitionCallMatches(
            operation,
            semantic,
            ctx.deriver,
            ctx.classes,
            ctx.conversions,
            ctx.definitionOf,
            ctx.fixedDataDefinitionAttributes?.get(operation)
          )
        ) {
          demands.push({
            key: 'call-abi:fixed-data-definition',
            verdict: 'missing',
            detail: 'fixed data definition does not match its authenticated call'
          })
        }
        if (
          node !== null &&
          recipe.value !== null &&
          (representationKey(node.source) !== representationKey(recipe.value.value) ||
            representationKey(node.target) !== representationKey(recipe.held))
        ) {
          demands.push({
            key: `conversion:${recipe.conversion}`,
            verdict: 'missing',
            detail: 'fixed data definition conversion disagrees with its field'
          })
        } else if (recipe.conversion !== null) demands.push({ key: `conversion:${recipe.conversion}` })
        if (recipe.attributesOnly?.absence) demands.push({ key: `conversion:${recipe.attributesOnly.absence}` })
      }
      const callee = operation.callee.representation
      if (callee.kind === 'dynamic') demands.push({ key: 'call-abi:dynamic' })
      // A plugin host's own spelling table is consulted only for a host
      // carrier; core constructors keep `native: null` and render from the
      // target's own table, so asking the plugin set about them would refuse
      // a complete implementation (`preflight/host-invocation.ts`).
      if (callee.kind === 'native-handle' && callee.native !== null) {
        demands.push({ key: `host-invocation:${operation.kind === 'call' ? `${callee.native}.call` : callee.native}` })
      }
      return demands
    }
    case 'receiver': {
      if (operation.origin !== 'lexical') return []
      const semantic = ctx.semanticOperationOf(operation.lineage)
      return lexicalReceiverOriginMatches(operation, semantic)
        ? []
        : [
            {
              key: 'call-abi:logical-receiver',
              verdict: 'unsupported',
              detail: 'a lexical receiver lacks its canonical captured-receiver source proof'
            }
          ]
    }
    case 'bind-callable':
      return nativeLogicalReceiverAdmitted(operation, ctx.ignoredLogicalReceivers ?? new Set())
        ? []
        : [
            {
              key: 'call-abi:logical-receiver',
              verdict: 'unsupported',
              detail: 'a bound native logical receiver has no supported erased receiver protocol; its target is unknown or consumes this'
            }
          ]
    case 'get-iterator':
    case 'iterator-next':
    case 'iterator-close': {
      const sourceIgnores = (functionId: FunctionId): boolean => {
        const variants = [...ctx.bodies.values()].filter((body) => body.sourceOwner === functionId)
        return variants.length > 0 && variants.every(nativeBodyIgnoresLogicalReceiver)
      }
      return nativeIteratorLogicalReceiverAdmitted(
        operation,
        ctx.deriver,
        ctx.abis ?? new Map(),
        ctx.ignoredLogicalReceivers ?? new Set(),
        sourceIgnores
      )
        ? []
        : [
            {
              key: 'call-abi:logical-receiver',
              verdict: 'unsupported',
              detail: 'an internal iterator method consumes an unsupported erased native receiver'
            }
          ]
    }
    case 'allocate-callable': {
      const source = ctx.semanticOperationOf(operation.lineage)
      const published = source?.family === 'allocation' ? source.ownPrototypeProperty : undefined
      const valid =
        (operation.callableOwnPrototype === undefined && published === undefined) ||
        (source?.family === 'allocation' && source.callable === operation.functionId && published === operation.callableOwnPrototype)
      return [
        ...operation.captures.map((capture) => ({ key: `capture:${captureCapabilityOf(capture.representation)}` as CapabilityKey })),
        ...(!valid
          ? [
              {
                key: 'call-abi:native-callable-prototype' as CapabilityKey,
                verdict: 'missing' as const,
                detail: 'native MakeConstructor does not match its exact semantic allocation'
              }
            ]
          : [])
      ]
    }
    case 'allocate-constructor':
      // Each captured slot crosses a body boundary in its own ownership; the
      // capture path transports the ownerships the manifest lists and no other.
      return operation.captures.map((capture) => ({ key: `capture:${captureCapabilityOf(capture.representation)}` }))
    case 'binding-read':
      return ctx.externalBindings.has(operation.declaration) ? [{ key: 'native-boundary:external-binding' }] : []
    case 'get': {
      const validHostMethodRead =
        operation.nativeHostMethodRead === undefined ||
        nativeHostMethodReadMatches(operation, ctx.nativeHostMethodReads?.get(operation) ?? null)
      const key = ctx.definitionOf(operation.key.value)
      const keyText = key?.kind === 'constant' && key.literal === 'string' ? key.text : null
      const validLogicalReceiver =
        operation.logicalReceiver === undefined ||
        (operation.logicalReceiver === 'ignored' &&
          ctx.hosts !== undefined &&
          hostReadIgnoresLogicalReceiver(operation, ctx.hosts, keyText)) ||
        (operation.logicalReceiver === 'native' && bufferReadNeedsLogicalReceiver(operation, keyText)) ||
        (operation.logicalReceiver === 'dynamic' && operation.result.representation.kind === 'dynamic')
      return [
        ...dynamicGetResultDemandsOf(operation, ctx),
        ...getDemandsOf(operation, ctx),
        ...(!validHostMethodRead
          ? [
              {
                key: `property-access:${operation.receiver.representation.kind}:get:native-host-method-source` as CapabilityKey,
                verdict: 'missing' as const,
                detail: 'the deferred native method read does not match its exact source invocation and evaluated lookup frame'
              }
            ]
          : []),
        ...(!validLogicalReceiver
          ? [
              {
                key: 'call-abi:logical-receiver' as CapabilityKey,
                verdict: 'missing' as const,
                detail: 'logical receiver protocol does not match the authenticated getter'
              }
            ]
          : [])
      ]
    }
    case 'set':
    case 'define-own-property': {
      if (
        operation.kind === 'set' &&
        operation.ordinaryFunctionDataWrite === true &&
        !ordinaryFunctionDataWriteMatches(operation, ctx.semanticOperationOf(operation.lineage), ctx.definitionOf(operation.key.value))
      )
        return [
          {
            key: 'property-access:function-and-constructor:set:own-data-source',
            verdict: 'missing',
            detail: 'ordinary Function data installation lacks its canonical constant-key prototype proof'
          }
        ]
      // The write twin of the sealed read recipe above, and validated the same
      // way: a demand is raised ONLY when the certificate has gone stale
      // against the operation it rides on. A well-formed one asks for nothing
      // new -- the emitter renders it as ordinary constant-key stores, whose
      // storage the receiver's own `:set:` claims already cover.
      const recipe = operation.typedComputedWrite
      if (recipe === undefined) return []
      if (recipe.receiver === representationKey(operation.receiver.representation) && recipe.keys.length > 0) return []
      return [
        {
          key: `property-access:${operation.receiver.representation.kind}:${operation.kind}:typed-computed-write` as CapabilityKey,
          verdict: 'missing',
          detail: 'the sealed computed-write recipe does not match the set operation receiver'
        }
      ]
    }
    case 'throw':
      return [{ key: 'abrupt-edge:throw' }]
    case 'await':
    case 'yield':
      return [{ key: 'abrupt-edge:suspend' }]
    case 'return':
      // A return that leaves a try region runs its finally clause on the way
      // out; a body with no region completes the ordinary way and asks nothing.
      return ctx.body.tryRegions.length > 0 ? [{ key: 'abrupt-edge:return' }] : []
    default:
      return []
  }
}

/** Every capability one operation needs, in the manifest's namespace. */
export const capabilityKeysOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => [
  ...(operation.kind === 'call' &&
  (ctx.nativeCallablePrototypeDescriptors?.required.has(operation) || operation.nativeCallablePrototypeDescriptor !== undefined)
    ? nativeCallablePrototypeMatches(
        ctx.nativeCallablePrototypeDescriptors?.receipts.get(operation),
        operation.nativeCallablePrototypeDescriptor
      )
      ? [{ key: `conversion:${operation.nativeCallablePrototypeDescriptor!.materialization}` as CapabilityKey }]
      : [
          {
            key: 'call-abi:native-callable-prototype' as CapabilityKey,
            verdict: 'missing' as const,
            detail: 'a descriptor value needs the original native prototype and current physical backpointer entry'
          }
        ]
    : []),
  ...(operation.kind === 'convert' &&
  (ctx.nativeCallablePrototypeObservations?.has(operation) || operation.nativeCallablePrototypeObservation !== undefined) &&
  !nativeCallablePrototypeMatches(ctx.nativeCallablePrototypeObservations?.get(operation), operation.nativeCallablePrototypeObservation)
    ? [
        {
          key: 'call-abi:native-callable-prototype' as CapabilityKey,
          verdict: 'missing' as const,
          detail: 'an erased native prototype callback requires its actual physical allocation entry and declared-any conversion'
        }
      ]
    : []),
  ...(operation.kind === 'get' &&
  (ctx.nativeCallablePrototypes?.required.has(operation) === true || operation.nativeCallablePrototype !== undefined)
    ? nativeCallablePrototypeMatches(ctx.nativeCallablePrototypes?.receipts.get(operation), operation.nativeCallablePrototype)
      ? operation.nativeCallablePrototype!.materialization === null
        ? []
        : [{ key: `conversion:${operation.nativeCallablePrototype!.materialization}` as CapabilityKey }]
      : [
          {
            key: 'property-access:function:get:native-prototype' as CapabilityKey,
            verdict: 'missing' as const,
            detail: 'the native prototype requires its exact allocation, physical body entry and genuine observation recipe'
          }
        ]
    : []),
  ...(operation.kind === 'call' &&
  (ctx.nativeCallableIntegrity?.required.has(operation) === true || operation.nativeCallableIntegrity !== undefined) &&
  !nativeCallableIntegrityMatches(ctx.nativeCallableIntegrity?.receipts.get(operation), operation.nativeCallableIntegrity)
    ? [
        {
          key: 'call-abi:native-callable-integrity' as CapabilityKey,
          verdict: 'missing' as const,
          detail: 'native Function integrity requires the exact source family and complete own prototype descriptors'
        }
      ]
    : []),
  ...nativeOwnAssignmentDemandsOf(operation, ctx),
  ...(((operation.kind === 'has-property' || operation.kind === 'get') && operation.ordinaryObjectPrototypeKeyAbsent === true) ||
  (operation.kind === 'set' && operation.ordinaryObjectDataWriteAbsent === true)
    ? !nativePropertyPrototypeAbsenceMatches(
        operation,
        ctx.semanticOperationOf(operation.lineage),
        ctx.definitionOf,
        ctx.conversions,
        ctx.semanticOperationOf
      )
      ? [
          {
            key: `property-access:${operation.receiver.representation.kind}:${operation.kind}:source-prototype` as CapabilityKey,
            verdict: 'missing' as const,
            detail: 'the standard prototype absence fact does not authenticate this exact source property key and receiver'
          }
        ]
      : []
    : []),
  ...((operation.kind === 'allocate-record' || operation.kind === 'allocate-ordinary-object') &&
  operation.ordinaryObjectPrototype === true &&
  !nativeOrdinaryAllocationMatches(operation, ctx.semanticOperationOf(operation.lineage))
    ? [
        {
          key: 'allocation:standard-object:source-prototype' as CapabilityKey,
          verdict: 'missing' as const,
          detail: 'a standard object prototype requires the exact plain-object allocation source'
        }
      ]
    : []),
  ...nativeObjectDataSlotDemandsOf(operation, ctx),
  ...nativeCallableDataSlotDemandsOf(operation, ctx),
  ...nativeDocumentEntryDemandsOf(operation, ctx),
  ...nativeFieldViewDemandsOf(operation, ctx),
  ...(operation.kind === 'construct' ? nativeEntryFieldDemandsOf(operation, ctx) : []),
  ...(operation.kind === 'get-iterator' && operation.protocol !== 'enumerate'
    ? nativeIteratorFieldDemandsOf(
        { value: operation.result.id, representation: operation.result.representation },
        'next',
        operation.nativeNextMethodRead,
        ctx
      )
    : []),
  ...(operation.kind === 'iterator-next' || operation.kind === 'iterator-close'
    ? nativeIteratorFieldDemandsOf(
        operation.iterator,
        operation.kind === 'iterator-next' ? 'next' : 'return',
        operation.nativeMethodRead,
        ctx
      )
    : []),
  ...((operation.kind === 'get' || operation.kind === 'set') &&
  operation.privateNativeCallableSlot !== undefined &&
  !nativeCallablePrivateSlotMatches(ctx.privateNativeCallableSlots?.get(operation), operation.privateNativeCallableSlot)
    ? [
        {
          key: 'property-access:function-and-constructor:get:private-native-slot' as CapabilityKey,
          verdict: 'missing' as const,
          detail: 'a private native callable slot disagrees with its actual source, initialization or observation closure'
        }
      ]
    : []),
  ...internalConversionDemandsOf(operation, ctx),
  ...ownDemandsOf(operation, ctx),
  ...propertyAccessKeysOf(operation, ctx),
  ...runtimeHelperKeysOf(operation, ctx)
]

const nativeOwnAssignmentDemandsOf = (operation: IrOperation, ctx: CertifyContext): CapabilityDemand[] => {
  if (operation.kind !== 'call') return []
  const semantic = ctx.semanticOperationOf(operation.lineage)
  const planned =
    ctx.calleeRendering && semantic?.family === 'invocation'
      ? plannedHostTemplateOf(ctx.calleeRendering, semantic, operation.callee.representation)
      : null
  const stockAssignment = operation.hostTemplate === 'object-assign' || planned === 'object-assign'
  // Removing an intrinsic fact or the lowered frame marker cannot restore
  // the carrier-based host dispatch. Recompute its actual Get/key/ambient
  // owner and the normalized stock source before considering native copies.
  if (
    stockAssignment &&
    authenticatedNativeHostMethodReadOf(operation, semantic, ctx.calleeRendering, ctx.definitionOf, ctx.hosts?.members, 'object-assign') ===
      null
  )
    return [
      {
        key: 'call-abi:native-own-assignment',
        verdict: 'missing',
        detail: 'a stock bulk assignment has no intact source member and authenticated actual native host entry'
      }
    ]
  const target = operation.arguments[0]?.representation
  const layout = target === undefined ? null : nativeOwnAssignmentLayoutOf(target, ctx.deriver)
  const surfaces = (value: Representation): readonly Representation[] =>
    value.kind === 'optional'
      ? surfaces(value.payload)
      : value.kind === 'tagged-union'
        ? value.arms.flatMap((arm) => surfaces(arm.value))
        : [value]
  const dynamic = (value: Representation): boolean => value.kind === 'dynamic' || (value.kind === 'optional' && dynamic(value.payload))
  const physicalBoundary =
    semantic?.family === 'invocation' &&
    semantic.intrinsicMutation === 'object-assign' &&
    target !== undefined &&
    'ownership' in target &&
    target.ownership === 'shared-refcount' &&
    layout !== null &&
    operation.arguments.slice(1).some((argument) =>
      surfaces(argument.representation).some((surface) => {
        const source = nativeOwnAssignmentLayoutOf(surface, ctx.deriver)
        return source?.fields.some((field) => !dynamic(field.value) && !layout.fields.some((held) => held.key === field.key)) === true
      })
    )
  const required =
    physicalBoundary ||
    (semantic?.family === 'invocation' &&
      semantic.nativeOwnAssignment !== undefined &&
      layout !== null &&
      semantic.nativeOwnAssignment.sources.some((source) =>
        source.roots.some((root) => root.slots.some((slot) => !layout.fields.some((field) => field.key === slot.key)))
      ))
  if (!required && operation.nativeOwnAssignment === undefined) return []
  const block = [...ctx.body.blocks.values()].find((block) => block.operations.includes(operation))
  const expected =
    !ctx.calleeRendering || !block
      ? null
      : nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), {
          graph: ctx.graph,
          deriver: ctx.deriver,
          conversions: ctx.conversions,
          placements: ctx.placements,
          selected: ctx.calleeRendering.plan.selected,
          calleeRendering: ctx.calleeRendering,
          definitionOf: ctx.definitionOf,
          bodyOf: () => ctx.body
        })
  if (!nativeOwnAssignmentRecipesMatch(expected, operation.nativeOwnAssignment))
    return [
      {
        key: 'call-abi:native-own-assignment' as CapabilityKey,
        verdict: 'missing',
        detail:
          'a typed bulk extension requires its exact original target, current source descriptors and complete native writer/storage domain'
      }
    ]
  return operation.nativeOwnAssignment!.sources.flatMap((source) => [
    ...source.roots.flatMap((root) =>
      root.readers.flatMap((reader) => (reader.conversion === null ? [] : [{ key: `conversion:${reader.conversion}` as CapabilityKey }]))
    ),
    ...source.fields.flatMap((field) => [
      { key: `conversion:${field.conversion}` as CapabilityKey },
      ...(field.materialization === undefined ? [] : [{ key: `conversion:${field.materialization}` as CapabilityKey }]),
      ...(field.documentRead === undefined ? [] : [{ key: `conversion:${field.documentRead}` as CapabilityKey }]),
      ...field.storageFits.map((fit) => ({ key: `conversion:${fit.conversion}` as CapabilityKey }))
    ])
  ])
}

// A Function the program's own dynamic-fallback opt-in allocated as a boxed
// object (every allocation `dynamic`/`opt-in-fallback`) has no native frame
// to hold a typed slot: each access already crosses the declared dynamic
// boundary into that object's own property table, so no reader can observe a
// native copy the write would bypass. Any other dynamic owner stays refused.
const optInFallbackOwnersByBodies = new WeakMap<object, ReadonlyMap<FunctionId, boolean>>()
const ownerIsOptInFallbackObject = (bodies: ReadonlyMap<PhysicalBodyId, IrBody>, owner: FunctionId): boolean => {
  let owners = optInFallbackOwnersByBodies.get(bodies)
  if (owners === undefined) {
    const census = new Map<FunctionId, boolean>()
    for (const body of bodies.values())
      for (const block of body.blocks.values())
        for (const operation of allOperationsOf(block)) {
          if (operation.kind !== 'allocate-callable') continue
          const representation = operation.result.representation
          const fallback = representation.kind === 'dynamic' && representation.reason === 'opt-in-fallback'
          census.set(operation.functionId, (census.get(operation.functionId) ?? true) && fallback)
        }
    owners = census
    optInFallbackOwnersByBodies.set(bodies, owners)
  }
  return owners.get(owner) === true
}

/** Native storage requires the actual owner/all-writer schema and successful
 * dominating installation. Removing or substituting the marker cannot restore
 * a dynamic property fallback after publication selected the native frame.
 */
const slotOwnerIsOptInFallback = (ctx: CertifyContext, operationId: SemanticOperation['id']): boolean => {
  const owner = nativeCallableDataOwnerAt(ctx.nativeCallableData, operationId)
  return owner !== null && ownerIsOptInFallbackObject(ctx.bodies, owner)
}
const nativeCallableDataSlotDemandsOf = (operation: IrOperation, ctx: CertifyContext): CapabilityDemand[] => {
  if (operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'call') return []
  const source = ctx.semanticOperationOf(operation.lineage)
  if (
    operation.kind === 'set' &&
    (operation.nativeCallableReadonlySet !== undefined || (source?.family === 'property' && source.nativeCallableReadonlySet !== undefined))
  ) {
    if (nativeCallableReadonlySetMatches(ctx.nativeCallableReadonlySets?.get(operation), operation.nativeCallableReadonlySet))
      return operation.nativeCallableReadonlySet!.conversions.map((conversion) => ({ key: `conversion:${conversion}` as CapabilityKey }))
    return [
      {
        key: 'property-access:function:get:native-data-slot',
        verdict: 'missing',
        detail: 'readonly native Function Set does not authenticate its exact source, current descriptor, key and entry frame'
      }
    ]
  }
  if (operation.kind !== 'get' && operation.nativeCallableDataWrite !== undefined) {
    if (nativeCallableDataWriteMatches(ctx.nativeCallableDataWrites?.get(operation), operation.nativeCallableDataWrite))
      return [
        { key: `conversion:${operation.nativeCallableDataWrite.storageConversion}` },
        ...operation.nativeCallableDataWrite.storageFits.map(({ conversion }) => ({ key: `conversion:${conversion}` as CapabilityKey })),
        ...(operation.nativeCallableDataWrite.materialization === null
          ? []
          : [{ key: `conversion:${operation.nativeCallableDataWrite.materialization}` as CapabilityKey }]),
        ...(operation.nativeCallableDataWrite.receiverMaterialization === null
          ? []
          : [{ key: `conversion:${operation.nativeCallableDataWrite.receiverMaterialization}` as CapabilityKey }])
      ]
    return [
      {
        key: 'property-access:function:get:native-data-slot',
        verdict: 'missing',
        detail: 'native Function write does not authenticate its actual target, key, source and lazy boundary recipes'
      }
    ]
  }
  const semantic = ctx.semanticOperationOf(operation.lineage)
  // A sealed private constructor route has its own exact initialization and
  // observation proof. It does not use the ordinary Function sidecar protocol.
  if (
    operation.kind !== 'call' &&
    operation.privateNativeCallableSlot !== undefined &&
    nativeCallablePrivateSlotMatches(ctx.privateNativeCallableSlots?.get(operation), operation.privateNativeCallableSlot)
  )
    return []
  const actualWrite =
    operation.kind === 'set'
      ? { receiver: operation.receiver, value: operation.value }
      : operation.kind === 'call' && operation.intrinsicReflection === 'set' && operation.arguments[0] && operation.arguments[2]
        ? { receiver: operation.arguments[0], value: operation.arguments[2] }
        : null
  const readKey = operation.kind === 'get' ? ctx.definitionOf(operation.key.value) : null
  const writtenKey =
    operation.kind === 'set'
      ? ctx.definitionOf(operation.key.value)
      : actualWrite !== null && operation.kind === 'call'
        ? ctx.definitionOf(operation.arguments[1]!.value)
        : null
  // The Function's own `prototype` cell is the identity table's Value (see
  // `nativeCallableDataStorageRequiresAuthorityAt`); no data-slot receipt
  // exists for it, so a native value written there is not a data slot.
  const writesOwnPrototype = writtenKey?.kind === 'constant' && writtenKey.literal === 'string' && writtenKey.text === 'prototype'
  if (
    operation.kind === 'get' &&
    operation.nativeCallableUninstalledKey !== undefined &&
    nativeCallableUninstalledKeyOf(
      operation,
      readKey?.kind === 'constant' && readKey.literal === 'string' ? readKey.text : null,
      ctx.bodies,
      ctx.graph
    ) !== operation.nativeCallableUninstalledKey
  )
    return [
      {
        key: 'property-access:function:get:native-data-slot' as CapabilityKey,
        verdict: 'missing',
        detail: 'a native Function read claims an uninstalled key that some program operation may install'
      }
    ]
  const required =
    nativeCallableTypedDataReadRequiresAuthority(
      operation,
      readKey?.kind === 'constant' && readKey.literal === 'string' ? readKey.text : null
    ) ||
    (semantic !== null &&
      nativeCallableDataStorageRequiresAuthorityAt(ctx.graph, ctx.nativeCallableData, semantic.id, ctx.deriver) &&
      !slotOwnerIsOptInFallback(ctx, semantic.id)) ||
    (actualWrite !== null &&
      !writesOwnPrototype &&
      isNativeCallableCarrier(actualWrite.receiver.representation.kind) &&
      actualWrite.value.representation.kind !== 'dynamic')
  if (!required && operation.nativeCallableDataSlot === undefined) return []
  if (nativeCallableDataSlotMatches(ctx.nativeCallableDataSlots?.get(operation), operation.nativeCallableDataSlot)) {
    const receipt = operation.nativeCallableDataSlot!
    return [
      ...(receipt.materialization === null ? [] : [{ key: `conversion:${receipt.materialization}` as CapabilityKey }]),
      ...(receipt.presentRead === undefined
        ? []
        : [
            { key: `conversion:${receipt.presentRead.conversion}` as CapabilityKey },
            ...receipt.presentRead.installations.map(({ conversion }) => ({ key: `conversion:${conversion}` as CapabilityKey }))
          ]),
      ...(receipt.optionalRead === undefined
        ? []
        : [
            { key: `conversion:${receipt.optionalRead.present}` as CapabilityKey },
            { key: `conversion:${receipt.optionalRead.absent}` as CapabilityKey },
            ...receipt.optionalRead.installations.map(({ conversion }) => ({ key: `conversion:${conversion}` as CapabilityKey }))
          ])
    ]
  }
  return [
    {
      key: 'property-access:function:get:native-data-slot' as CapabilityKey,
      verdict: 'missing',
      detail: 'native Function data storage does not authenticate its exact owner, source, dominating installation and actual frame'
    }
  ]
}

/** Exact all-writer/source allocation proof is required independently of the
 * attached marker. A typed extension cannot recover a boxed lookup by removing
 * its receipt or substituting a structurally equal owner.
 */
const nativeObjectDataSlotDemandsOf = (operation: IrOperation, ctx: CertifyContext): CapabilityDemand[] => {
  if (operation.kind !== 'get' && operation.kind !== 'set') return []
  const required = ctx.nativeObjectDataSlotCandidates?.has(operation) === true
  if (!required && operation.nativeObjectDataSlot === undefined) return []
  const receipt = operation.nativeObjectDataSlot
  if (!nativeObjectDataSlotMatches(ctx.nativeObjectDataSlots?.get(operation), receipt))
    return [
      {
        key: `property-access:${operation.receiver.representation.kind}:${operation.kind}:native-data-slot`,
        verdict: 'missing',
        detail: 'a native object extension lacks its complete source allocation, writer, absence and physical storage receipt'
      }
    ]
  return [
    ...receipt!.read.map((entry) => ({ key: `conversion:${entry.conversion}` as CapabilityKey })),
    ...(receipt!.write === null ? [] : [{ key: `conversion:${receipt!.write.conversion}` as CapabilityKey }]),
    ...(receipt!.materialization === undefined ? [] : [{ key: `conversion:${receipt!.materialization}` as CapabilityKey }])
  ]
}

/** `new Map(entries)` reads "0"/"1" of a live-view entry only through the view's own routes. */
const nativeEntryFieldDemandsOf = (
  operation: import('./model.js').ConstructOperation,
  ctx: CertifyContext
): readonly CapabilityDemand[] => {
  const required = nativeEntryFieldReadsRequired(operation, ctx.nativeFieldViewTargets ?? new Set())
  const receipt = operation.nativeEntryFieldReads
  if (!required && receipt === undefined) return []
  const expected = required ? nativeEntryFieldReadsOf(operation, ctx.nativeFieldViewPlans ?? [], ctx.conversions) : null
  if (!nativeEntryFieldReadsMatch(expected, receipt))
    return [
      {
        key: 'property-access:array-object:get:native-field-view',
        verdict: 'missing',
        detail: 'a Map seeded from live-view entries lacks the exact view routes for its "0"/"1" reads'
      }
    ]
  return [...receipt!.key.sources, ...receipt!.value.sources].map((entry) => ({ key: `conversion:${entry.conversion}` }))
}

/** Internal Get(next/return) has the same original-allocation proof as an ordinary Get. */
const nativeIteratorFieldDemandsOf = (
  receiver: import('./model.js').IrOperand,
  key: 'next' | 'return',
  receipt: NativeIteratorFieldRead | undefined,
  ctx: CertifyContext
): readonly CapabilityDemand[] => {
  const required = nativeFieldViewCarrierNeedsReceipt(receiver.representation, ctx.nativeFieldViewTargets ?? new Set())
  if (!required && receipt === undefined) return []
  const expected =
    required && ctx.nativeFieldViews
      ? nativeIteratorFieldReadOf(receiver, key, ctx.deriver, ctx.abis ?? new Map(), ctx.nativeFieldViews, ctx.conversions)
      : null
  if (!nativeIteratorFieldReadMatches(expected, receipt))
    return [
      {
        key: `property-access:${receiver.representation.kind}:get:native-field-view`,
        verdict: 'missing',
        detail: `an internal iterator ${key} read lacks its exact original-allocation/native-frame receipt`
      }
    ]
  return receipt!.read.sources.map((entry) => ({ key: `conversion:${entry.conversion}` }))
}

const constantKeyTextOf = (operation: GetOperation | SetOperation, ctx: CertifyContext): string | null =>
  constantPropertyKeyTextOf(ctx.definitionOf(operation.key.value))

const nativeFieldViewDemandsOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  if (operation.kind !== 'get' && operation.kind !== 'set') return []
  if (
    ctx.nativeFieldViews &&
    nativeDocumentEntryMatches(
      nativeDocumentEntryOf(operation, ctx.nativeFieldViews, ctx.conversions, ctx.deriver, constantKeyTextOf(operation, ctx)),
      operation.nativeDocumentEntry
    )
  )
    return []
  if (nativeObjectDataSlotMatches(ctx.nativeObjectDataSlots?.get(operation), operation.nativeObjectDataSlot)) return []
  const receipt = operation.kind === 'get' ? operation.nativeFieldViewRead : operation.nativeFieldViewWrite
  const required = nativeFieldViewOperationNeedsReceipt(operation, ctx.nativeFieldViewTargets ?? new Set(), ctx.authenticatedHosts)
  if (!required && receipt === undefined) return []
  const key = constantKeyTextOf(operation, ctx)
  const semantic = ctx.semanticOperationOf(operation.lineage)
  if (
    required &&
    receipt === undefined &&
    nativeFieldViewOpenDocumentRead(
      operation,
      key,
      ctx.nativeFieldViewTargets ?? new Set(),
      ctx.nativeFieldViewDocumentTargets ?? new Set()
    )
  )
    return []
  const keyDomain = key === null && semantic?.family === 'property' ? computedPropertyKeyTextsOf(ctx.graph, semantic) : undefined
  const copiedDomain = operation.provenKeyTexts
  const authenticDomain =
    keyDomain !== undefined &&
    copiedDomain !== undefined &&
    keyDomain.length === copiedDomain.length &&
    keyDomain.every((text, index) => text === copiedDomain[index])
  const expected =
    required && ctx.nativeFieldViews
      ? operation.kind === 'get'
        ? key !== null
          ? nativeFieldViewReadOf(operation, key, ctx.nativeFieldViews, ctx.conversions)
          : authenticDomain
            ? nativeFieldViewReadSelectionOf(operation, keyDomain!, ctx.nativeFieldViews, ctx.conversions)
            : copiedDomain === undefined
              ? nativeFieldViewOpenReadOf(operation, ctx.nativeFieldViews, ctx.conversions)
              : null
        : key !== null
          ? nativeFieldViewWriteOf(operation, key, ctx.nativeFieldViews, ctx.conversions)
          : authenticDomain
            ? nativeFieldViewWriteSelectionOf(operation, keyDomain!, ctx.nativeFieldViews, ctx.conversions)
            : null
      : null
  if (!nativeFieldViewReceiptMatches(expected, receipt))
    return [
      {
        key: `property-access:${operation.receiver.representation.kind}:${operation.kind}:native-field-view`,
        verdict: 'missing',
        detail: 'a live native view has no exact allocation/slot conversion receipt for this property operation'
      }
    ]
  const admitted = receipt!
  const ids =
    'sources' in admitted
      ? admitted.sources.map((entry) => entry.conversion)
      : admitted.targets.flatMap((entry) => (entry.conversion === null ? [] : [entry.conversion]))
  return ids.map((id) => ({ key: `conversion:${id}` }))
}

const nativeDocumentEntryDemandsOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  if ((operation.kind !== 'get' && operation.kind !== 'set') || operation.nativeDocumentEntry === undefined) return []
  const expected = ctx.nativeFieldViews
    ? nativeDocumentEntryOf(operation, ctx.nativeFieldViews, ctx.conversions, ctx.deriver, constantKeyTextOf(operation, ctx))
    : null
  if (!nativeDocumentEntryMatches(expected, operation.nativeDocumentEntry))
    return [
      {
        key: `property-access:${operation.receiver.representation.kind}:${operation.kind}:native-field-view`,
        verdict: 'missing',
        detail: 'a Document entry requires its complete installed original owner protocol and exact future conversion'
      }
    ]
  return [
    ...operation.nativeDocumentEntry.views,
    ...(operation.nativeDocumentEntry.arrayEntry?.readers.map((reader) => reader.array) ?? []),
    operation.nativeDocumentEntry.conversion
  ].map((id) => ({ key: `conversion:${id}` }))
}

const internalConversionDemandsOf = (operation: IrOperation, ctx: CertifyContext): readonly CapabilityDemand[] => {
  const key = 'key' in operation ? ctx.definitionOf(operation.key.value) : null
  const keyText = key?.kind === 'constant' && (key.literal === 'string' || key.literal === 'number') ? key.text : null
  const hostArgumentsDynamic =
    operation.kind === 'call' && ctx.authenticatedHosts?.functionReads.get(operation.callee.value)?.arguments === 'dynamic'
  const expected = operationConversionInputsOf(
    operation,
    keyText,
    ctx.deriver,
    ctx.classes,
    hostArgumentsDynamic,
    ctx.abis,
    ctx.definitionOf,
    ctx.body,
    ctx.virtualFrames,
    ctx.hosts,
    ctx.wellKnownSymbols,
    ctx.hostMethodAliases
  )
  const actual = operation.conversionRecipes ?? []
  const flagsAuthentic =
    operation.kind !== 'call' ||
    intrinsicCallFlagsMatch(operation, ctx.semanticOperationOf(operation.lineage), ctx.calleeRendering, ctx.definitionOf)
  const unionTargetAuthentic = operation.kind !== 'call' || nativeUnionMethodTargetMatches(operation, ctx.classes, ctx.definitionOf)
  const demands: CapabilityDemand[] =
    flagsAuthentic && unionTargetAuthentic && operationConversionsMatch(expected, actual, ctx.conversions)
      ? actual.map((recipe) => ({ key: `conversion:${recipe.conversion}` }))
      : [
          {
            key: 'runtime-helper:internal-conversion-recipes',
            verdict: 'missing',
            detail: !unionTargetAuthentic
              ? 'native union method targets disagree with the Function selected by the authenticated property read'
              : flagsAuthentic
                ? 'internal value recipes disagree with the operation storage and result carriers'
                : 'intrinsic template flags disagree with the authenticated source invocation and callee rendering'
          }
        ]
  if (operation.kind === 'spread-copy') {
    if (!spreadCopyConversionPlanMatches(operation, operation.spreadConversionPlan, ctx.deriver, ctx.conversions))
      demands.push({
        key: 'runtime-helper:spread-conversion-recipes',
        verdict: 'missing',
        detail: 'spread conversion recipes disagree with the native copy routes'
      })
    else for (const node of operation.spreadConversionPlan!.leaves.values()) demands.push({ key: `conversion:${node.id}` })
  }
  if (operation.kind === 'call') {
    const snapshotRequired =
      operation.nativeArrayDescriptorSnapshot !== undefined ||
      nativeArrayDescriptorSnapshotRequired(operation, ctx.definitionOf, ctx.nativeFieldViews?.nativeArrayViewValues, ctx.hostMethodAliases)
    if (snapshotRequired)
      demands.push({
        key: 'runtime-helper:native-array-descriptor-snapshot',
        verdict:
          ctx.nativeFieldViews &&
          nativeArrayDescriptorSnapshotMatches(operation, ctx.definitionOf, ctx.nativeFieldViews, {
            bodies: ctx.bodies,
            placements: ctx.placements,
            classes: ctx.classes,
            conversions: ctx.conversions,
            deriver: ctx.deriver,
            calleeRendering: ctx.calleeRendering,
            ...(ctx.hostMethodAliases ? { hostMethodAliases: ctx.hostMethodAliases } : {})
          })
            ? 'installed'
            : 'missing',
        detail:
          'a live array descriptor needs an original getter-blind snapshot, closed snapshot uses, and exact deferred native value reader'
      })
    if (operation.nativeArrayDescriptorSnapshot) demands.push({ key: `conversion:${operation.nativeArrayDescriptorSnapshot.conversion}` })
    if (
      !hostObjectWalkPlanMatches(
        operation,
        operation.hostObjectWalkPlan,
        ctx.definitionOf,
        ctx.deriver,
        ctx.classes,
        ctx.conversions,
        ctx.hostMethodAliases
      )
    )
      demands.push({
        key: 'runtime-helper:host-object-walk-recipes',
        verdict: 'missing',
        detail: 'Object walk recipes disagree with the admitted native callback routes'
      })
    else
      for (const leaves of operation.hostObjectWalkPlan?.routes.values() ?? [])
        for (const node of leaves.values()) demands.push({ key: `conversion:${node.id}` })
  }
  if (operation.kind === 'get') {
    if (
      keyText !== null &&
      operation.receiver.representation.kind === 'class-ref' &&
      !classMethodFamilyHasNativeBody(ctx.classes, operation.receiver.representation.declaration, keyText) &&
      classFamilyMayAllocate(ctx.classes, operation.receiver.representation.declaration)
    )
      demands.push({
        key: 'property-access:computed-class-method-virtual',
        verdict: 'missing',
        detail: 'an evaluated native method read has no executable source implementation or override family'
      })
    const abis =
      ctx.abis ??
      new Map<FunctionId, CallableAbi>(
        [...ctx.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi]]))
      )
    const methods = methodConversionInputsOf(operation, keyText, ctx.classes, abis, ctx.deriver, ctx.body)
    if (!methodValueRecipesMatch(methods, operation.methodValueRecipes ?? [], ctx.conversions))
      demands.push({
        key: 'runtime-helper:native-method-recipes',
        verdict: 'missing',
        detail: 'method recipes disagree with the authenticated native method ABI'
      })
    else for (const recipe of operation.methodValueRecipes ?? []) demands.push({ key: `conversion:${recipe.conversion}` })
  }
  return demands
}

interface Decision {
  readonly verdict: CapabilityVerdict
  readonly reason: string
}

const registered = (installed: boolean, family: CapabilityFamily, discriminator: string): Decision =>
  installed
    ? { verdict: 'installed', reason: '' }
    : { verdict: 'missing', reason: `the target manifest registers no ${family} "${discriminator}"` }

/**
 * The one lookup. Each family names the manifest set (or the census) that
 * answers it; a family with no set is decided by the demand itself, and a
 * demand in such a family that arrives undecided is refused -- fail closed,
 * never silently installed.
 */
const verdictOf = (demand: CapabilityDemand, ctx: Pick<CertifyContext, 'manifest' | 'conversions'>): Decision => {
  if (demand.verdict !== undefined) return { verdict: demand.verdict, reason: demand.detail ?? '' }
  const family = familyOf(demand.key)
  const discriminator = discriminatorOf(demand.key)
  const manifest = ctx.manifest
  switch (family) {
    case 'physical-cpp-type':
    case 'host-member-call':
      return { verdict: 'missing', reason: `${demand.key} was demanded without a verdict` }
    case 'call-abi':
      return registered(discriminator === 'generic' ? manifest.hasGenericCallPath : manifest.hasDynamicCallPath, family, discriminator)
    case 'host-invocation':
      return registered(
        (manifest.hostInvocations?.has(discriminator) ||
          manifest.hostConstructors?.has(discriminator) ||
          manifest.hostMembers?.has(discriminator)) ??
          false,
        family,
        discriminator
      )
    case 'property-access':
      return registered(manifest.propertyRecipes.has(discriminator), family, discriminator)
    case 'capture':
      return registered(manifest.captureOwnershipSupport.has(discriminator), family, discriminator)
    case 'conversion': {
      const node = ctx.conversions.nodeById(discriminator)
      if (node === null) return { verdict: 'missing', reason: `no conversion node was minted for ${discriminator}` }
      if ('materializer' in node.capability && node.capability.materializer.nativeArrayView) {
        const { nativeArrayView: plan, dependencies } = node.capability.materializer
        if (
          !nativeArrayViewPlanMatches(plan, node.source, node.target, ctx.conversions.nodeById) ||
          !plan.dependencies.every((child) => dependencies?.includes(child) === true)
        )
          return { verdict: 'missing', reason: 'a live native array recipe has no exact source storage and complete canonical callbacks' }
      }
      if ('materializer' in node.capability && node.capability.materializer.nativeDescriptorSnapshot) {
        const { nativeDescriptorSnapshot: plan, dependencies } = node.capability.materializer
        if (
          !nativeDescriptorSnapshotPlanMatches(plan, ctx.conversions.nodeById) ||
          !plan.dependencies.every((child) => dependencies?.includes(child) === true)
        )
          return {
            verdict: 'missing',
            reason: 'a native descriptor snapshot has no exact copied storage and complete deferred field readers'
          }
      }
      return node.capability.kind === 'never'
        ? { verdict: 'unsupported', reason: node.capability.reason }
        : { verdict: 'installed', reason: '' }
    }
    case 'native-boundary':
      return discriminator === 'external-binding'
        ? registered(manifest.supportsExternalBindings ?? false, family, discriminator)
        : registered(manifest.nativeProtocols.has(discriminator), family, discriminator)
    case 'runtime-helper':
      if (manifest.runtimeHelpers.has(discriminator)) return { verdict: 'installed', reason: '' }
      if (manifest.unsupportedRuntimeHelpers.has(discriminator)) {
        return { verdict: 'unsupported', reason: `the target declares runtime helper "${discriminator}" unsupported` }
      }
      return registered(false, family, discriminator)
    case 'abrupt-edge':
      return registered(manifest.abruptEdgeHandlers.has(discriminator), family, discriminator)
    case 'parallel-region':
      return { verdict: 'unsupported', reason: `${demand.key} was demanded without a verdict` }
  }
}

const contextFor = (
  input: CertifyInput,
  body: IrBody,
  virtualFrames: ReadonlyMap<string, CallableAbi>,
  hostMethodAliases: ReadonlyMap<DeclarationId, HostMethodAlias>,
  readOnlyDictionary: ReturnType<typeof createReadOnlyDictionaryAuthority>,
  ignoredLogicalReceivers: ReadonlySet<IrValueId>,
  callableSources: ReturnType<typeof nativeCallableFlowOf>['callables']
): CertifyContext => {
  const definitions = new Map<IrValueId, IrOperation>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of allOperationsOf(block)) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
    }
  }
  return {
    ...input,
    body,
    nativeHostMethodReads: nativeHostMethodReadProofsOf(body, input.calleeRendering, input.hosts?.members),
    virtualFrames,
    hostMethodAliases,
    readOnlyDictionary,
    ignoredLogicalReceivers,
    callableSources,
    ...(input.hosts
      ? {
          authenticatedHosts: hostNamespaceReadsOf(
            body,
            input.placements,
            input.hosts,
            new Map(
              [...definitions].flatMap(([id, op]) =>
                op.kind === 'constant' && (op.literal === 'string' || op.literal === 'number') ? [[id, op.text]] : []
              )
            )
          )
        }
      : {}),
    definitionOf: (value) => definitions.get(value) ?? null,
    semanticOperationOf: (lineage) => input.graph.operations.get(operationOfResult(lineage)) ?? null,
    isDead: (lineage) => input.deadTypeofGuards.isDeadOperation(operationOfResult(lineage))
  }
}

/**
 * What one body's environment must transport, as `capture:` demands.
 *
 * Read off `IrBody.facts` -- `ir/captures.ts`'s whole-program answer, sealed
 * onto the body after the shake -- and NOT off `allocate-callable`'s
 * `captures` operand, which no producer fills. Until this existed the capture
 * question was certified by nobody and decided only at print time, so a
 * carrier the target could not transport certified clean and then emitted
 * nothing: precisely the certify/print disagreement 2.3's gate exists to
 * catch.
 *
 * The rules mirror `targets/cpp/captures.ts`'s admission exactly, because
 * they are the same rule asked at two stages rather than two rules:
 * a declaration with no placement is not a capture the environment carries; a
 * BOXED one is shared by aliasing, so copying its `std::shared_ptr` handle is
 * safe whatever its own carrier's ownership tier says, and only a carrier the
 * plan never selected (or left `unresolved`) is refusable there; everything
 * else, receiver included, must name an ownership the manifest publishes.
 */
const captureDemandsOf = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  boxed: ReadonlySet<DeclarationId>
): readonly CapabilityDemand[] => {
  const facts = body.facts
  if (!facts) return []
  const demands: CapabilityDemand[] = []
  for (const declaration of facts.capturedDeclarations) {
    const placement = placements.get(declaration)
    if (!placement) continue
    const representation = placement.representation ?? null
    if (boxed.has(declaration)) {
      if (representation === null || representation.kind === 'unresolved')
        demands.push({ key: `capture:${captureCapabilityOf(representation)}` })
      continue
    }
    demands.push({ key: `capture:${captureCapabilityOf(representation)}` })
  }
  if (facts.capturedReceiver) demands.push({ key: `capture:${captureCapabilityOf(facts.capturedReceiver)}` })
  return demands
}

/**
 * Walks every body and decides every demand. One refusal per (owner, key):
 * the same missing recipe demanded at forty sites of one function is one
 * capability the target lacks, not forty, and the row names which.
 */
export const certifyIr = (input: CertifyInput): IrCertification => {
  const virtualFrames = settledVirtualCallFramesOf(input.bodies.values(), input.classes, input.conversions)
  const hostMethodAliases = input.hosts
    ? buildHostMethodAliasIndex([...input.bodies.values()], input.placements, input.hosts)
    : new Map<DeclarationId, HostMethodAlias>()
  const demanded = new Set<CapabilityKey>()
  const refusals: Refusal[] = []
  const refused = new Set<string>()
  const visitedConversions = new Set<string>()
  const decide = (
    owner: string,
    demand: CapabilityDemand,
    ctx: Pick<CertifyContext, 'manifest' | 'conversions'>,
    site?: IrOperation,
    walkClosure = true
  ): void => {
    demanded.add(demand.key)
    if (walkClosure && demand.key.startsWith('conversion:') && !visitedConversions.has(`${owner}|${demand.key}`)) {
      visitedConversions.add(`${owner}|${demand.key}`)
      const node = ctx.conversions.nodeById(discriminatorOf(demand.key))
      if (node) {
        try {
          const missingReferences = new Set<string>()
          const closure = recipeClosureOf([node], (id) => {
            const referenced = ctx.conversions.nodeById(id)
            if (referenced === null) missingReferences.add(id)
            return referenced
          })
          for (const child of closure.values()) {
            if (child === node) continue
            visitedConversions.add(`${owner}|conversion:${child.id}`)
            const canonical = ctx.conversions.nodeById(child.id)
            decide(
              owner,
              canonical === child
                ? { key: `conversion:${child.id}` }
                : {
                    key: `conversion:${child.id}`,
                    verdict: 'missing',
                    detail: 'a nested conversion recipe has no matching census citation'
                  },
              ctx,
              site,
              false
            )
          }
          for (const id of missingReferences)
            decide(
              owner,
              { key: `conversion:${id}`, verdict: 'missing', detail: 'a recursive conversion recipe names no census node' },
              ctx,
              site,
              false
            )
        } catch (error) {
          demand = {
            key: demand.key,
            verdict: 'missing',
            detail: `conversion closure has conflicting recipe citations: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      }
    }
    const decision = verdictOf(demand, ctx)
    if (decision.verdict === 'installed') return
    const dedupe = `${owner}|${demand.key}`
    if (refused.has(dedupe)) return
    refused.add(dedupe)
    // The owner is the whole function; the first operation that demanded the
    // key is what a reader needs to find the construct inside it.
    const reason = decision.reason || `${demand.key} is ${decision.verdict}`
    refusals.push({ stage: 'certify', key: demand.key, owner, reason: site ? `${reason} (first at ${String(site.lineage)})` : reason })
  }

  const programInputs = programConversionInputsOf({
    bodies: input.bodies.values(),
    classes: input.classes,
    deriver: input.deriver,
    conversions: input.conversions,
    ...(input.representations ? { representations: input.representations } : {}),
    ...(input.reflection ? { reflection: input.reflection } : {})
  })
  const programRecipes = input.programConversionRecipes ?? []
  const programRecipesMatch = programConversionRecipesMatch(programInputs, programRecipes, input.conversions)
  if (!programRecipesMatch)
    decide(
      'program',
      {
        key: 'runtime-helper:program-conversion-recipes',
        verdict: 'missing',
        detail: 'native artifact conversion recipes disagree with the final body and class contracts'
      },
      input
    )
  else for (const recipe of programRecipes) decide(recipe.owner, { key: `conversion:${recipe.conversion.id}` }, input)

  for (const row of input.slotDrift) {
    // No body context is needed: the row already carries the pair and the
    // census's own reason, and there is no lookup left to do.
    demanded.add(`conversion:${row.source}->${row.slot}`)
    const dedupe = `${row.operation}|conversion:${row.source}->${row.slot}`
    if (refused.has(dedupe)) continue
    refused.add(dedupe)
    refusals.push({ stage: 'certify', key: `conversion:${row.source}->${row.slot}`, owner: String(row.operation), reason: row.reason })
  }

  // The whole-program boxed set: a declaration belongs to exactly one physical
  // frame, so the union of every body's own set is the answer every frame
  // touching the cell shares -- the same union `CaptureIndex.isBoxed` takes.
  const boxed = new Set<DeclarationId>()
  for (const body of input.bodies.values()) for (const declaration of body.facts?.boxed ?? []) boxed.add(declaration)

  let readOnlyIndex: ReturnType<typeof createReadOnlyDictionaryAuthority> | null = null
  const readOnlyDictionary: ReturnType<typeof createReadOnlyDictionaryAuthority> = {
    proofOf: (root) => (readOnlyIndex ??= createReadOnlyDictionaryAuthority(input)).proofOf(root),
    matches: (root, proof) => (readOnlyIndex ??= createReadOnlyDictionaryAuthority(input)).matches(root, proof)
  }
  const callableFlow = nativeCallableFlowOf(
    [...input.bodies.values()],
    input.placements,
    input.classes,
    input.conversions,
    undefined,
    input.deriver,
    programRecipesMatch ? programRecipes : undefined
  )
  const ignoredLogicalReceivers = callableFlow.ignoredLogicalReceiverValues
  const fixedDataDefinitionAttributes = fixedDataDefinitionAttributesOf({ ...input, calleeRendering: input.calleeRendering })
  // Every callable receipt is recomputed from this one flow, the flow
  // publication derived from the same final bodies and program recipes.
  const callableInput = { ...input, callableFlow }
  const nativeCallableDataSlots = nativeCallableDataSlotsOf(callableInput)
  const nativeCallableReadonlySets = nativeCallableReadonlySetsOf(callableInput)
  const nativeCallableDataWrites = nativeCallableDataWritesOf(callableInput)
  const nativeCallableIntegrity = nativeCallableIntegrityAuthorityOf(callableInput)
  const nativeCallablePrototypes = nativeCallablePrototypeReadsOf(callableInput)
  const nativeCallablePrototypeObservations = nativeCallablePrototypeObservationsOf(callableInput)
  const nativeCallablePrototypeDescriptors = nativeCallablePrototypeDescriptorsOf(callableInput)
  const nativeObjectData = nativeObjectDataSlotAuthorityOf(input)
  const nativeObjectDataSlots = nativeObjectData.receipts
  const nativeFieldViewPlans = nativeFieldViewLivePlansOf(
    input.bodies.values(),
    input.conversions,
    programRecipesMatch ? programRecipes : undefined
  )
  const nativeFieldViewTargets = nativeFieldViewTargetSetOf(nativeFieldViewPlans)
  const nativeFieldViewDocumentTargets = nativeFieldViewDocumentTargetSetOf(nativeFieldViewPlans)
  const privateNativeCallableSlots = [...input.bodies.values()].some((body) =>
    [...body.blocks.values()].some((block) =>
      block.operations.some(
        (operation) => (operation.kind === 'get' || operation.kind === 'set') && operation.privateNativeCallableSlot !== undefined
      )
    )
  )
    ? nativeCallablePrivateSlotsOf(input)
    : new Map<IrOperation, NativeCallablePrivateSlot>()
  for (const body of input.bodies.values()) {
    const ctx = {
      ...contextFor(input, body, virtualFrames, hostMethodAliases, readOnlyDictionary, ignoredLogicalReceivers, callableFlow.callables),
      fixedDataDefinitionAttributes,
      privateNativeCallableSlots,
      nativeCallableDataSlots,
      nativeCallableReadonlySets,
      nativeCallableDataWrites,
      nativeCallableIntegrity,
      nativeCallablePrototypes,
      nativeCallablePrototypeObservations,
      nativeCallablePrototypeDescriptors,
      nativeObjectDataSlots,
      nativeObjectDataSlotCandidates: nativeObjectData.required,
      nativeFieldViews: callableFlow,
      nativeFieldViewTargets,
      nativeFieldViewDocumentTargets,
      nativeFieldViewPlans
    }
    const owner = String(body.sourceOwner)
    if (
      ctx.authenticatedHosts &&
      (!body.hostNamespaceCensus || !hostNamespaceCensusMatches(ctx.authenticatedHosts, body.hostNamespaceCensus))
    )
      decide(
        owner,
        {
          key: 'runtime-helper:host-namespace-census',
          verdict: 'missing',
          detail: 'host packing facts disagree with the authenticated host table'
        },
        ctx
      )
    if (body.denseLoopPlan) {
      if (!denseLoopPlanMatches(body, body.denseLoopPlan, input.placements, input.conversions))
        decide(
          owner,
          {
            key: 'runtime-helper:dense-loop-conversions',
            verdict: 'missing',
            detail: 'dense storage recipes disagree with their native value definitions'
          },
          ctx
        )
      else for (const node of denseLoopConversionsOf(body.denseLoopPlan)) decide(owner, { key: `conversion:${node.id}` }, ctx)
    }
    for (const demand of captureDemandsOf(body, input.placements, boxed)) decide(owner, demand, ctx)
    for (const demand of abiDemands(input.manifest, body.abi)) decide(owner, demand, ctx)
    for (const demand of abiDemands(input.manifest, body.construct)) decide(owner, demand, ctx)
    // Every SSA value's carrier must be spellable, and a `native-handle` among
    // them must name an authenticated protocol -- the two facts preflight read
    // off each published result, read here off the body's own value index.
    for (const representation of body.values.values()) {
      decide(owner, physicalTypeDemand(input.manifest, representation), ctx)
      const boundary = nativeBoundaryDemand(representation)
      if (boundary) decide(owner, boundary, ctx)
      for (const demand of embeddedNativeBoundaryDemands(representation)) decide(owner, demand, ctx)
    }
    for (const region of body.iteratorCloseRegions ?? [])
      for (const demand of nativeIteratorFieldDemandsOf(region.iterator, 'return', region.nativeMethodRead, ctx)) decide(owner, demand, ctx)
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        for (const demand of capabilityKeysOf(operation, ctx)) decide(owner, demand, ctx, operation)
      }
    }
  }

  // A parallel region is certified as a whole: whether a write races depends on
  // what every body the region reaches can hold, so this family is one
  // whole-program question rather than a per-operation lookup.
  if (input.parallelRegionEntries && input.parallelRegionEntries.size > 0) {
    for (const refusal of parallelRegionRefusalsOf({
      bodies: input.bodies,
      placements: input.placements,
      entries: input.parallelRegionEntries,
      graph: input.graph,
      classes: input.classes,
      ...(input.parallelRegionSource ? { nameOfDeclaration: input.parallelRegionSource.nameOfDeclaration } : {})
    })) {
      const key: CapabilityKey = 'parallel-region:pure'
      demanded.add(key)
      const dedupe = `${refusal.owner}|${key}|${refusal.detail}`
      if (refused.has(dedupe)) continue
      refused.add(dedupe)
      refusals.push({
        stage: 'certify',
        key,
        owner: refusal.owner,
        reason: `parallel region ${refusal.detail} (first at ${(refusal.site.lineage && input.parallelRegionSource?.locationOfLineage(refusal.site.lineage)) || String(refusal.site.lineage)})`
      })
    }
  }

  return Object.freeze({
    certified: refusals.length === 0 && input.blocked.length === 0,
    refusals: Object.freeze(refusals),
    demanded: Object.freeze([...demanded].sort())
  })
}
