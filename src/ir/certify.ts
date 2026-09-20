import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, IrValueId, SemanticResultId } from '../identity/ids.js'
import { operationOfResult } from '../identity/ids.js'
import type { TargetRuntimeManifest } from '../preflight/obligations.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { captureCapabilityOf, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { DeadTypeofGuardCensus } from '../semantics/normalize/dead-typeof-guards.js'
import { propertyAccessKeysOf } from './certify/property-access.js'
import { runtimeHelperKeysOf } from './certify/runtime-helper.js'
import type { IrLoweringBlocker } from './lower.js'
import type { SlotDrift } from './lower-operands.js'
import { allOperationsOf, type IrBody, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'
import type { PhysicalBodyId } from '../identity/ids.js'
import type { Refusal } from './refusal.js'
import { nativeMergeTransportMatches } from './native-merge-transport.js'
import { nativeFieldOwnerReadMatches } from './native-field-owner.js'
import { absentClassArmsHold } from './absent-class-arm.js'
import type { ReflectionExposure } from './reflection-demand.js'
import { objectValueConversionInputsOf, objectValueConversionsMatch } from './object-value-conversions.js'

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
  'abrupt-edge'
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
}

/** What the families see: the whole-program inputs plus the body being walked. */
export interface CertifyContext extends CertifyInput {
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

const abiDemands = (manifest: TargetRuntimeManifest, abi: CallableAbi | null): CapabilityDemand[] => {
  if (abi === null) return []
  const carriers: Representation[] = [...abi.parameters.map((parameter) => parameter.value), abi.result]
  if (abi.receiver !== null) carriers.push(abi.receiver)
  return carriers.flatMap((carrier) => {
    const boundary = nativeBoundaryDemand(carrier)
    return boundary ? [physicalTypeDemand(manifest, carrier), boundary] : [physicalTypeDemand(manifest, carrier)]
  })
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
    case 'merge-live-arm-rebuild': {
      const recipe = operation.nativeTransport
      if (!recipe) return []
      if (!nativeMergeTransportMatches(operation, ctx.conversions))
        return [
          {
            key: 'runtime-helper:merge-live-arm-rebuild:native-transport',
            verdict: 'missing',
            detail: 'native merge transport disagrees with its live arms or conversion nodes'
          }
        ]
      return [
        ...recipe.arms.map((arm) => ({ key: `conversion:${arm.conversion}` as CapabilityKey })),
        ...(recipe.absence ? [{ key: `conversion:${recipe.absence}` as CapabilityKey }] : [])
      ]
    }
    case 'convert':
      // The node the instruction cites decides the pair; a `never` node here
      // is one lowering minted deliberately (`convertOrDrift`) so the printer's
      // own path could still try, and certification refuses it by name.
      return [{ key: `conversion:${operation.conversionUse}` }]
    case 'call':
    case 'construct': {
      const demands: CapabilityDemand[] = [{ key: 'call-abi:generic' }]
      if (operation.kind === 'call' && operation.objectValueConversions) {
        const semantic = ctx.semanticOperationOf(operation.lineage)
        const expected = objectValueConversionInputsOf(
          semantic?.family === 'invocation' ? semantic.intrinsicMutation : undefined,
          operation.arguments,
          ctx.deriver
        )
        if (operation.argumentsAreSpread || !objectValueConversionsMatch(expected, operation.objectValueConversions, ctx.conversions))
          demands.push({
            key: 'call-abi:object-value-conversions',
            verdict: 'missing',
            detail: 'Object value conversions do not match the authenticated field sources'
          })
        for (const value of operation.objectValueConversions) demands.push({ key: `conversion:${value.conversion}` })
      }
      if (operation.kind === 'call' && operation.fixedDataDefinition) {
        const recipe = operation.fixedDataDefinition
        const target = operation.arguments[0]?.representation
        const descriptor = operation.arguments[2]?.representation
        const semantic = ctx.semanticOperationOf(operation.lineage)
        const key = semantic?.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 1)
        const node = ctx.conversions.nodeById(recipe.conversion)
        const native =
          node?.capability.kind === 'identity' ||
          ((node?.capability.kind === 'atom' || node?.capability.kind === 'static') &&
            node.capability.materializer.nativeFieldProtocol === 'unused')
        if (
          !target ||
          !descriptor ||
          operation.argumentsAreSpread ||
          operation.arguments.length !== 3 ||
          recipe.target !== representationKey(target) ||
          recipe.descriptor !== representationKey(descriptor) ||
          !operation.result ||
          representationKey(operation.result.representation) !== recipe.target ||
          semantic?.family !== 'invocation' ||
          semantic.intrinsicMutation !== 'object-define-property' ||
          key?.source.kind !== 'constant' ||
          key.source.literal !== 'string' ||
          key.source.text !== recipe.field.key ||
          (recipe.nativeFieldProtocol === 'unused' && (!semantic.intrinsicDataDefinition || !native))
        ) {
          demands.push({
            key: 'call-abi:fixed-data-definition',
            verdict: 'missing',
            detail: 'fixed data definition does not match its authenticated call'
          })
        }
        if (
          node !== null &&
          (representationKey(node.source) !== representationKey(recipe.value.value) ||
            representationKey(node.target) !== representationKey(recipe.held))
        ) {
          demands.push({
            key: `conversion:${recipe.conversion}`,
            verdict: 'missing',
            detail: 'fixed data definition conversion disagrees with its field'
          })
        } else demands.push({ key: `conversion:${recipe.conversion}` })
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
    case 'allocate-callable':
    case 'allocate-constructor':
      // Each captured slot crosses a body boundary in its own ownership; the
      // capture path transports the ownerships the manifest lists and no other.
      return operation.captures.map((capture) => ({ key: `capture:${captureCapabilityOf(capture.representation)}` }))
    case 'binding-read':
      return ctx.externalBindings.has(operation.declaration) ? [{ key: 'native-boundary:external-binding' }] : []
    case 'get': {
      if (operation.absentClassArms !== undefined) {
        const key = ctx.definitionOf(operation.key.value)
        if (
          !absentClassArmsHold(
            operation,
            key?.kind === 'constant' && key.literal === 'string' ? key.text : null,
            ctx.classes,
            ctx.reflection
          )
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
      if (
        recipe.receiver !== representationKey(operation.receiver.representation) ||
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
    case 'set': {
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
          key: `property-access:${operation.receiver.representation.kind}:set:typed-computed-write` as CapabilityKey,
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
  ...ownDemandsOf(operation, ctx),
  ...propertyAccessKeysOf(operation, ctx),
  ...runtimeHelperKeysOf(operation, ctx)
]

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
const verdictOf = (demand: CapabilityDemand, ctx: CertifyContext): Decision => {
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
  }
}

const contextFor = (input: CertifyInput, body: IrBody): CertifyContext => {
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
  const demanded = new Set<CapabilityKey>()
  const refusals: Refusal[] = []
  const refused = new Set<string>()
  const decide = (owner: string, demand: CapabilityDemand, ctx: CertifyContext): void => {
    demanded.add(demand.key)
    const decision = verdictOf(demand, ctx)
    if (decision.verdict === 'installed') return
    const dedupe = `${owner}|${demand.key}`
    if (refused.has(dedupe)) return
    refused.add(dedupe)
    refusals.push({ stage: 'certify', key: demand.key, owner, reason: decision.reason || `${demand.key} is ${decision.verdict}` })
  }

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

  for (const body of input.bodies.values()) {
    const ctx = contextFor(input, body)
    const owner = String(body.sourceOwner)
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
    }
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        for (const demand of capabilityKeysOf(operation, ctx)) decide(owner, demand, ctx)
      }
    }
  }

  return Object.freeze({
    certified: refusals.length === 0 && input.blocked.length === 0,
    refusals: Object.freeze(refusals),
    demanded: Object.freeze([...demanded].sort())
  })
}
