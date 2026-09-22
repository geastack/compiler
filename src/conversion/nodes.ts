import type { Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { ConversionCapability, ConversionNode, ConversionNodeId } from './algebra.js'
import { validateCapability } from './algebra.js'
import { createConversionDerivationContext, deriveConversionCapability } from './derive.js'
import { narrowingCapabilityFor } from './build.js'
import type { CoercionOperation, ConversionRuntimeRegistry } from './registry.js'

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
  /** The node a `convert` instruction names, from whichever table minted it; `null` for an id no census minted. */
  readonly nodeById: (id: ConversionNodeId) => ConversionNode | null
  /** Every node minted through `nodeFor` that the eager graph did not already hold. */
  readonly minted: ReadonlyMap<ConversionNodeId, ConversionNode>
}

export interface ConversionCensusInput {
  readonly registry: ConversionRuntimeRegistry
  readonly nodes: ReadonlyMap<ConversionNodeId, ConversionNode>
}

export const conversionNodeIdOf = (source: Representation, target: Representation): ConversionNodeId =>
  `${representationKey(source)}->${representationKey(target)}`

/** The carrier each abstract operation lands on. */
export const coercionTargetOf = (operation: CoercionOperation): Representation =>
  operation === 'ToNumber' ? { kind: 'scalar', domain: 'number' } : { kind: 'string' }

const containsUnresolved = (representation: Representation): boolean => representationKey(representation).includes('unresolved')

export const createConversionNodes = (input: ConversionCensusInput): ConversionCensus => {
  const minted = new Map<ConversionNodeId, ConversionNode>()
  const context = createConversionDerivationContext(input.registry)

  const capabilityOf = (source: Representation, target: Representation, sourceKey: string, targetKey: string): ConversionCapability => {
    if (sourceKey === targetKey) return { kind: 'identity' }
    if (target.kind === 'void') {
      return { kind: 'static', materializer: { id: 'chain:discard-into-void', domain: 'static:discard-into-void', allocates: false } }
    }
    if (source.kind === 'void') return { kind: 'never', reason: `a void source has no value to convert into ${targetKey}` }
    if (containsUnresolved(source) || containsUnresolved(target)) {
      return { kind: 'never', reason: `an unresolved carrier in ${sourceKey} -> ${targetKey} names no conversion` }
    }
    if (source.kind === 'dynamic') {
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
    const recipe = input.registry.staticRecipe(source, target)
    if (recipe) return { kind: 'static', materializer: recipe }
    return { kind: 'never', reason: `no runtime conversion is installed from ${sourceKey} to ${targetKey}` }
  }

  const nodeFor = (source: Representation, target: Representation): ConversionNode => {
    const sourceKey = representationKey(source)
    const targetKey = representationKey(target)
    const id = `${sourceKey}->${targetKey}`
    const eager = input.nodes.get(id)
    if (eager !== undefined) return eager
    const remembered = minted.get(id)
    if (remembered !== undefined) return remembered
    const capability = capabilityOf(source, target, sourceKey, targetKey)
    validateCapability(capability, new Set([...input.nodes.keys(), ...minted.keys(), id]))
    const node: ConversionNode = { id, source, target, capability }
    minted.set(id, node)
    return node
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

  const nodeById = (id: ConversionNodeId): ConversionNode | null =>
    input.nodes.get(id) ?? minted.get(id) ?? coercions.get(id) ?? exactArms.get(id) ?? null

  return { nodeFor, coercionFor, exactArmFor, nodeById, minted }
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
  if (source.kind !== 'tagged-union') return null
  const targetKey = representationKey(target)
  const matches = source.arms.flatMap((arm, index) => (representationKey(arm.value) === targetKey ? [index] : []))
  return matches.length === 1 ? (matches[0] ?? null) : null
}
