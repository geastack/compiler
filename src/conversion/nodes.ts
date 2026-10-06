import type { Representation, TaggedUnionArm } from '../representation/model.js'
import { isOpenDocument, representationKey, standInRefuses } from '../representation/model.js'
import type { ConversionCapability, ConversionNode, ConversionNodeId } from './algebra.js'
import { validateCapability } from './algebra.js'
import { createConversionDerivationContext, deriveConversionCapability } from './derive.js'
import { narrowingCapabilityFor } from './build.js'
import type { CoercionOperation, ConversionRuntimeRegistry } from './registry.js'
import type { FamilyMemberKeys } from './record-view.js'
import { impossibleFieldReadOf, IMPOSSIBLE_FIELD_READ } from './impossible-field-read.js'
import { nativeUnboundMethodContractOf, NATIVE_UNBOUND_METHOD_MATERIALIZER } from './native-method.js'

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
  readonly fieldReadFor: (source: Representation, target: Representation) => ConversionNode
  readonly absentIndexReadFor: (source: Representation, target: Representation) => ConversionNode
  readonly nativeMethodFor: (source: Representation, target: Representation) => ConversionNode | null
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
   * mongodb's `executeOperation` does `catch (error) { return
   * operation.handleError(error) }` with `handleError(error: MongoError)`,
   * whose every implementation rethrows what it does not recognize; in JS a
   * non-MongoError reaches it and propagates as the operation's rejection.
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
   * parameter's absence. mongodb's `executeCommands` keeps `let thrownError =
   * null` (typed `any`) and, on success, passes it to `mergeBatchResults(...,
   * err?: AnyError, ...)`. The callee was checked against `T | undefined`, so
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
 * `X.prototype.m.call(y, ...)` is the program shape: `mongodb-connection-
 * string-url` borrows `CaseInsensitiveMap.prototype._normalizeKey` onto its
 * `URLSearchParams` subclass. The body was compiled against `X`'s layout and
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

export const createConversionNodes = (input: ConversionCensusInput): ConversionCensus => {
  const minted = new Map<ConversionNodeId, ConversionNode>()
  const deriving = new Set<ConversionNodeId>()
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
    const structural = input.registry.structuralRecipe?.(source, target, nodeFor)
    if (structural) return { kind: 'static', materializer: structural }
    const recipe = input.registry.staticRecipe(source, target)
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
    if (deriving.has(id))
      return { id, source, target, capability: { kind: 'never', reason: `recursive structural conversion ${id} has no finite leaf proof` } }
    deriving.add(id)
    let capability: ConversionCapability
    try {
      const eager = input.nodes.get(id)
      capability = eager?.capability ?? capabilityOf(source, target, sourceKey, targetKey)
      if (capability.kind === 'static' || capability.kind === 'atom') {
        const materializer = capability.materializer
        if (materializer.id === 'view:structural-record' || materializer.id === 'gea::record::classStructuralView') {
          const sealed = input.registry.structuralRecipe?.(source, target, nodeFor)
          capability = sealed?.recordView
            ? { ...capability, materializer: { ...materializer, ...sealed, id: materializer.id } }
            : { kind: 'never', reason: `structural conversion ${id} has no admitted leaf plan` }
        } else if (materializer.id === 'gea::Promise::adopt-converted' && source.kind === 'promise' && target.kind === 'promise') {
          const child = nodeFor(source.value, target.value)
          capability = child.capability.kind === 'never'
            ? child.capability
            : { ...capability, materializer: { ...materializer, dependencies: [child] } }
        }
      }
    } finally {
      deriving.delete(id)
    }
    // A membership view, not a Set copied from both tables: the copy was made
    // once per minted pair, quadratic in the census, and was the mongodb
    // driver's single largest lowering cost (20 of 35 seconds).
    validateCapability(capability, { has: (known) => known === id || input.nodes.has(known) || minted.has(known) })
    const node: ConversionNode = { id, source, target, capability }
    minted.set(id, node)
    return node
  }

  const contextual = new Map<ConversionNodeId, ConversionNode>()
  const contextualNode = (source: Representation, target: Representation, context: string, materializer: import('./algebra.js').MaterializerContract): ConversionNode => {
    const id = `${conversionNodeIdOf(source, target)}#${context}`
    const remembered = contextual.get(id)
    if (remembered) return remembered
    const node: ConversionNode = { id, source, target, capability: { kind: 'static', materializer } }
    contextual.set(id, node)
    return node
  }
  const fieldReadFor = (source: Representation, target: Representation): ConversionNode => {
    const ordinary = nodeFor(source, target)
    if (ordinary.capability.kind !== 'never' || !impossibleFieldReadOf(source, target)) return ordinary
    return contextualNode(source, target, 'field-read', {
      id: IMPOSSIBLE_FIELD_READ, domain: 'static:impossible-field-read', allocates: false, nativeFieldProtocol: 'unused'
    })
  }
  const absentIndexReadFor = (source: Representation, target: Representation): ConversionNode => {
    const ordinary = nodeFor(source, target)
    if (ordinary.capability.kind !== 'never') return ordinary
    return contextualNode(source, target, 'index-read', {
      id: IMPOSSIBLE_INDEX_READ, domain: 'static:impossible-index-read', allocates: false, nativeFieldProtocol: 'unused'
    })
  }
  const nativeMethodFor = (source: Representation, target: Representation): ConversionNode | null => {
    const nativeMethod = nativeUnboundMethodContractOf(source, target)
    if (!nativeMethod) return null
    return contextualNode(source, target, 'native-method', {
      id: NATIVE_UNBOUND_METHOD_MATERIALIZER, domain: 'static:native-unbound-method', allocates: true,
      callableIdentityTransport: 'preserved', nativeFieldProtocol: 'unused', nativeMethod
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
    if (source.kind !== 'tagged-union') return null
    if (target.kind === 'tagged-union' || target.kind === 'dynamic' || target.kind === 'optional') return null
    const id = `${representationKey(source)}->${representationKey(target)}#asserted-union${copyAllowed ? ':copy' : ''}`
    const remembered = assertedUnions.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: {
          id: copyAllowed ? ASSERTED_UNION_COPY_MATERIALIZER : ASSERTED_UNION_MATERIALIZER,
          domain: copyAllowed ? 'static:asserted-union-copy' : 'static:asserted-union',
          allocates: copyAllowed
        }
      }
    }
    assertedUnions.set(id, node)
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
    const materializer = input.registry.structuralRecipe?.(source, target, nodeFor, members) ?? null
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
    if (source.kind !== 'dynamic' || target.kind !== 'optional' || target.absence !== 'undefined') return null
    const id = `${representationKey(source)}->${representationKey(target)}#nullish-optional`
    const remembered = nullishOptionals.get(id)
    if (remembered !== undefined) return remembered
    const node: ConversionNode = {
      id,
      source,
      target,
      capability: {
        kind: 'static',
        materializer: { id: NULLISH_OPTIONAL_MATERIALIZER, domain: 'static:nullish-optional', allocates: false }
      }
    }
    nullishOptionals.set(id, node)
    return node
  }

  const nodeById = (id: ConversionNodeId): ConversionNode | null =>
    minted.get(id) ??
    contextual.get(id) ??
    input.nodes.get(id) ??
    coercions.get(id) ??
    exactArms.get(id) ??
    nativeBaseViews.get(id) ??
    armViews.get(id) ??
    assertedUnions.get(id) ??
    familyMemberViews.get(id) ??
    caughtHandoffs.get(id) ??
    assertedClassDowncasts.get(id) ??
    nullishOptionals.get(id) ??
    null

  return {
    fieldReadFor,
    absentIndexReadFor,
    nativeMethodFor,
    nodeFor,
    coercionFor,
    exactArmFor,
    nativeBaseViewFor,
    armViewFor,
    assertedUnionFor,
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
