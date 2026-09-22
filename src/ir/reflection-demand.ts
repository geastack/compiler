import { nativeReflectFieldTransportOf } from './native-reflect-field.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, StructuralTypeId } from '../identity/ids.js'
import { classLayoutOfCopy, type ClassLayout, type PhysicalClassLayout } from '../projection/classes.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { classMemberOf, declaredRecordFieldOf } from '../projection/fields.js'
import { classPrototypeReadOf } from '../projection/class-prototype.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, RecordField, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { ConstantOperation, IrBody, IrOperand, IrOperation } from './model.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { conversionNodeIdOf, type ConversionCensus } from '../conversion/nodes.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import { hostTemplateFrameOf, nativeCallFrameOf, receivedCallArguments } from './call-entry.js'
import { censusClassStaticFieldSlots, staticFieldSlotOf } from './class-static-fields.js'
import { classConstructorBodyMatches, constructMatchesAbi } from './construct-entry.js'
import { nativeArrayTransportOf } from './native-array-transport.js'
import { nativeDictionaryTransportOf } from './native-dictionary-transport.js'
import { nativeRecordIndexHasPropertyOf, nativeRecordIndexTransportOf } from './native-record-index-transport.js'
import { nativeSequenceTransportOf } from './native-sequence-transport.js'
import { nativeCallableBindTransportOf } from './native-callable-bind.js'
import { hasNativePropertyLayout } from './native-fixed-layout.js'
import { nativeKeyQueryOf } from './native-key-query.js'
import { nativeCarrierPredicateOf } from './native-carrier-predicate.js'
import { nativeMergeTransportMatches } from './native-merge-transport.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { nativeSuperInitializationOf } from './native-class-initialization.js'
import { nativeClassAccessorEntryOf } from './native-class-accessor.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import { nativeHostConstructionOf } from './native-host-construction.js'
import { closePhysicalClassReflection } from './physical-class-reflection.js'
import { absentClassArmRead } from './absent-class-arm.js'
import { nativeAbsentPropertyReadOf } from './native-absent-property.js'

/** Complete retention choices for a generated native object's protocol. */
export type ReflectionDemandLevel = 'keys-only' | 'full'

export type ReflectionFieldOperation = 'read' | 'write' | 'native-read' | 'native-write' | 'descriptor' | 'define'
export type ReflectionFieldOperations = ReadonlyMap<string, ReadonlySet<ReflectionFieldOperation>>

export interface ReflectionDemand {
  readonly level: ReflectionDemandLevel
  /** Missing means unrestricted. An explicit map is the sealed per-field operation demand. */
  readonly fieldOperations?: ReflectionFieldOperations
  readonly reasons: ReadonlySet<string>
  readonly representations: ReadonlySet<string>
}

export interface ReflectionExposure {
  readonly classes: ReadonlyMap<DeclarationId, ReflectionDemand>
  readonly records: ReadonlyMap<StructuralTypeId, ReflectionDemand>
  readonly byRepresentation: ReadonlyMap<string, ReflectionDemand>
  readonly complete: boolean
  /** Opt-in provenance of full-demand propagation; it never changes the demand decision. */
  readonly boundaries?: {
    readonly origins: readonly { readonly reason: string; readonly carrier: Representation; readonly operation: IrOperation | null }[]
    readonly affecting: ReadonlyMap<string, ReadonlySet<number>>
    /** Reverse propagation edges let diagnostics recover later causes through already-expanded surfaces. */
    readonly parents: ReadonlyMap<string, ReadonlySet<string>>
    /** Loss reasons from the callable census over these exact bodies and layouts. */
    readonly callableReads: readonly { readonly operation: Extract<IrOperation, { kind: 'get' }>; readonly reason: string }[]
  }
}

export interface ReflectionExposureOptions {
  readonly wellKnownSymbols?: ReadonlyMap<DeclarationId, string>
  readonly physicalClasses?: ReadonlyMap<DeclarationId, PhysicalClassLayout>
  readonly representations: readonly Representation[]
  readonly shakeComplete: boolean
  readonly placements?: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly conversions?: Pick<ConversionCensus, 'nodeById'>
  readonly trace?: boolean
}

/**
 * Remove a computed-read candidate whose receiver did not receive a sealed
 * keys-only demand.  This is deliberately a post-census operation: the
 * lowering recipe owns finite-key and conversion eligibility, while this
 * authority decides whether the receiver's emitted protocol makes that recipe
 * available.  Missing rows fail closed and leave the ordinary dynamic read.
 */
export const finalizeTypedComputedReads = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  exposure: ReflectionExposure
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const finalized = new Map<PhysicalBodyId, IrBody>()
  let changedAny = false
  for (const [bodyId, body] of bodies) {
    let changed = false
    const blocks = new Map(body.blocks)
    for (const [blockId, block] of body.blocks) {
      let blockChanged = false
      const operations = block.operations.map((operation) => {
        if (operation.kind !== 'get' || operation.typedComputedRead === undefined) return operation
        const receiverKey = representationKey(operation.receiver.representation)
        const resultKey = representationKey(operation.result.representation)
        const shapeId =
          operation.receiver.representation.kind === 'record' ? (operation.receiver.representation.shapeId as StructuralTypeId) : null
        const demand = shapeId === null ? undefined : exposure.records.get(shapeId)
        const recipe = operation.typedComputedRead
        if (
          exposure.complete &&
          recipe.kind === 'closed-record' &&
          recipe.receiver === receiverKey &&
          recipe.result === resultKey &&
          demand?.level === 'keys-only'
        )
          return operation
        blockChanged = true
        changed = true
        const { typedComputedRead: _typedComputedRead, ...withoutRecipe } = operation
        return withoutRecipe
      })
      if (blockChanged) blocks.set(blockId, { ...block, operations })
    }
    if (changed) changedAny = true
    finalized.set(bodyId, changed ? { ...body, blocks } : body)
  }
  return changedAny ? finalized : bodies
}

const objectSurfacesOf = (representation: Representation): readonly Representation[] => {
  switch (representation.kind) {
    case 'record':
    case 'record-with-index':
    case 'class-ref':
    case 'native-record-ref':
    case 'array-object':
    case 'keyed-collection':
    case 'dictionary':
    case 'native-handle':
      return [representation]
    case 'borrowed-ref':
      return objectSurfacesOf(representation.referent)
    case 'optional':
      return objectSurfacesOf(representation.payload)
    case 'tagged-union':
      return representation.arms.flatMap((arm) => objectSurfacesOf(arm.value))
    case 'proxy-object':
      return [...objectSurfacesOf(representation.target), ...objectSurfacesOf(representation.handler)]
    default:
      return []
  }
}

/** Direct representation children that may contain another native object surface. */
const directChildrenOf = (
  representation: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver | null
): readonly Representation[] => {
  switch (representation.kind) {
    case 'optional':
      return [representation.payload]
    case 'borrowed-ref':
      return [representation.referent]
    case 'tagged-union':
      return representation.arms.map((arm) => arm.value)
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-dispatch':
    case 'function-value-family':
      return callableChildrenOf(representation.abi)
    case 'function-and-constructor':
      return [...callableChildrenOf(representation.call), ...callableChildrenOf(representation.construct)]
    case 'iterator':
      return [representation.element, representation.resume, representation.completion]
    case 'promise':
      return [representation.value]
    case 'native-sequence':
    case 'dense-buffer':
      return [representation.element]
    case 'proxy-object':
      return [representation.target, representation.handler]
    case 'record':
      return [...representation.fields.map((field) => field.value), ...representation.accessors.map((accessor) => accessor.value)]
    case 'record-with-index':
      return [...representation.fields.map((field) => field.value), ...representation.indexes.map((index) => index.value)]
    case 'class-ref': {
      const layout = classes.get(representation.declaration)
      if (layout?.nativeStorage !== undefined) {
        const raw = deriver?.layoutOf(representation.shapeId as StructuralTypeId)
        return [
          ...layout.nativeStorage.fields.map((field) => field.value),
          ...layout.staticFields.flatMap((field) => (field.representation ? [field.representation] : [])),
          ...(raw?.kind === 'record' ? raw.accessors.map((accessor) => accessor.value) : []),
          ...(raw?.kind === 'record-with-index' ? raw.indexes.map((index) => index.value) : [])
        ]
      }
      return [
        ...(layout?.fields.flatMap((field) => (field.representation ? [field.representation] : [])) ?? []),
        ...(layout?.staticFields.flatMap((field) => (field.representation ? [field.representation] : [])) ?? []),
        ...(deriver ? [deriver.layoutOf(representation.shapeId as StructuralTypeId)] : [])
      ]
    }
    case 'native-record-ref':
      return deriver ? [deriver.layoutOf(representation.shapeId as StructuralTypeId)] : []
    case 'array-object':
      return [representation.element, ...(representation.extension ?? []).map((field) => field.value)]
    case 'dictionary':
      return [representation.value]
    case 'keyed-collection':
      return representation.value ? [representation.key, representation.value] : [representation.key]
    case 'native-handle':
      return [representation.call, representation.construct].flatMap((abi) => (abi ? callableChildrenOf(abi) : []))
    default:
      return []
  }
}

const callableChildrenOf = (abi: {
  readonly result: Representation
  readonly receiver: Representation | null
  readonly parameters: readonly { readonly value: Representation }[]
}): readonly Representation[] => [
  abi.result,
  ...(abi.receiver ? [abi.receiver] : []),
  ...abi.parameters.map((parameter) => parameter.value)
]

/**
 * Publishing a callable publishes its possible return values, not objects
 * merely named by its input convention. Those inputs arrive from the caller;
 * the call operation accounts for their exposure. Decoding an argument into
 * a native frame does not publish that frame's fields back to dynamic code.
 * Keep the full type inventory in directChildrenOf for candidate discovery.
 */
const publishedChildrenOf = (
  representation: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver | null
): readonly Representation[] => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-dispatch':
    case 'function-value-family':
      return [representation.abi.result]
    case 'function-and-constructor':
      return [representation.call.result, representation.construct.result]
    case 'native-handle':
      return [representation.call, representation.construct].flatMap((abi) => (abi ? [abi.result] : []))
    default:
      return directChildrenOf(representation, classes, deriver)
  }
}

const callableAbiOf = (representation: Representation): CallableAbi | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-dispatch':
    case 'function-value-family':
      return representation.abi
    case 'function-and-constructor':
      return representation.call
    default:
      return null
  }
}

/** A callable value does not publish the values its signature says it could return. */
const isCallableCarrier = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-dispatch':
    case 'function-value-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-and-constructor':
      return true
    case 'optional':
      return isCallableCarrier(representation.payload)
    case 'borrowed-ref':
      return isCallableCarrier(representation.referent)
    case 'tagged-union':
      return representation.arms.every((arm) => arm.value.kind === 'undefined' || arm.value.kind === 'null' || isCallableCarrier(arm.value))
    default:
      return false
  }
}

/** Holding a deferred result does not inspect its payload. Actual invocation,
 * stepping, awaiting and publication operations below own that demand. */
const isDeferredCarrier = (representation: Representation): boolean => {
  if (isCallableCarrier(representation) || representation.kind === 'iterator' || representation.kind === 'promise') return true
  if (representation.kind === 'optional') return isDeferredCarrier(representation.payload)
  if (representation.kind === 'borrowed-ref') return isDeferredCarrier(representation.referent)
  return (
    representation.kind === 'tagged-union' &&
    representation.arms.every((arm) => arm.value.kind === 'undefined' || arm.value.kind === 'null' || isDeferredCarrier(arm.value))
  )
}

const abiMatches = (left: CallableAbi, right: CallableAbi): boolean =>
  left.restFrom === right.restFrom &&
  representationKey(left.result) === representationKey(right.result) &&
  (left.receiver === null
    ? right.receiver === null
    : right.receiver !== null && representationKey(left.receiver) === representationKey(right.receiver)) &&
  left.parameters.length === right.parameters.length &&
  left.parameters.every((parameter, index) => {
    const counterpart = right.parameters[index]
    return counterpart !== undefined && representationKey(parameter.value) === representationKey(counterpart.value)
  })

const constantsOf = (operations: readonly IrOperation[]): ReadonlyMap<string, ConstantOperation> => {
  const result = new Map<string, ConstantOperation>()
  for (const operation of operations) if (operation.kind === 'constant') result.set(String(operation.result.id), operation)
  return result
}

const keyOf = (operand: IrOperand | null, constants: ReadonlyMap<string, ConstantOperation>): string | null => {
  if (!operand) return null
  const constant = constants.get(String(operand.value))
  return constant && (constant.literal === 'string' || constant.literal === 'number') ? constant.text : null
}

const receiverOf = (operation: IrOperation): IrOperand | null => {
  switch (operation.kind) {
    case 'get':
    case 'set':
    case 'delete':
    case 'has-property':
    case 'define-own-property':
    case 'own-property-keys':
    case 'get-iterator':
      return operation.receiver
    default:
      return null
  }
}

const keyOperandOf = (operation: IrOperation): IrOperand | null => {
  switch (operation.kind) {
    case 'get':
    case 'set':
    case 'delete':
    case 'has-property':
    case 'define-own-property':
      return operation.key
    default:
      return null
  }
}

const extendsClass = (classes: ReadonlyMap<DeclarationId, ClassLayout>, candidate: DeclarationId, ancestor: DeclarationId): boolean => {
  const seen = new Set<DeclarationId>()
  let current: DeclarationId | null = candidate
  while (current !== null && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = classes.get(current)?.base ?? null
  }
  return false
}

const valueRepresentationOf = (operation: IrOperation): Representation | null => {
  switch (operation.kind) {
    case 'get':
      return operation.result.representation
    case 'set':
    case 'define-own-property':
      return operation.value.representation
    default:
      return null
  }
}

/**
 * A write the emitter lands in the declared member's own storage, converting
 * the value through the census node for exactly `value -> field` -- the
 * mirror of the read side's payload-transport allowance.
 *
 * three's uniform stores are the shape: `uniforms.tEquirect.value = texture`
 * (`WebGLCubeRenderTarget`), `uniforms.map.value = material.map`
 * (`WebGLMaterials`), the shadow-map and background uniforms. The uniform
 * record's `value` is a native sum of every carrier the program writes into
 * it, and the stored `Texture` enters it through
 * `gea::native-sum::inject-alternative` -- `Sum::ofArm<k>(ref)`, which neither
 * allocates, nor touches a field protocol, nor changes the payload it wraps.
 * Treated as an unproven slot, each such store published the written value's
 * whole carrier graph although the emitted C++ is one typed member
 * assignment; a later dynamic use of the uniform is censused on the sum
 * carrier itself and reaches every arm from there.
 *
 * A `define-own-property` qualifies only with the default data descriptor --
 * for this allowance AND for the exact-carrier and static-slot proofs beside
 * it. That is the emitter's own condition (`emit-properties.ts`'s
 * `isDefaultDataDescriptor`) for taking the ordinary member store. Any other
 * descriptor has no native member spelling at all: `emitFieldStoreLines`
 * admits it only into a `dictionary` table or a record's index sidecar, and
 * `recordIndexSidecarTableOf` declines a key the struct declares, so a
 * declared slot's non-default definition is either refused at emission or
 * lands in a sidecar whose non-disjoint spelling
 * (`emitRecordIndexSidecarStore`) boxes the value into a
 * `gea::PropertyDescriptor` for `gea_defineOwnField`. Neither is the typed
 * member store this census would otherwise be certifying.
 */
const storesIntoDeclaredSlot = (operation: IrOperation): boolean =>
  operation.kind === 'set' ||
  (operation.kind === 'define-own-property' &&
    operation.attributes.writable &&
    operation.attributes.enumerable &&
    operation.attributes.configurable)

const callMatchesAbi = (operation: Extract<IrOperation, { readonly kind: 'call' }>, abi: CallableAbi): boolean => {
  const resultMatches =
    abi.result.kind === 'void'
      ? operation.result === null
      : operation.result !== null && representationKey(operation.result.representation) === representationKey(abi.result)
  const receiverMatches =
    abi.receiver === null
      ? operation.receiver === null
      : operation.receiver !== null && representationKey(operation.receiver.representation) === representationKey(abi.receiver)
  return (
    resultMatches &&
    receiverMatches &&
    operation.arguments.length === abi.parameters.length &&
    operation.arguments.every(
      (argument, index) => representationKey(argument.representation) === representationKey(abi.parameters[index]!.value)
    )
  )
}

const promote = (
  rows: Map<string, { level: ReflectionDemandLevel; reasons: Set<string>; representations: Set<string> }>,
  representation: Representation,
  reason: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver | null,
  visited = new Set<string>(),
  publishedChildrenCache = new Map<string, readonly Representation[]>(),
  observe?: (representation: string, parent: string | null) => void
): void => {
  const work: {
    readonly value: Representation
    readonly reason: string
    readonly parent: string | null
    readonly inheritedProtocolOnly?: boolean
  }[] = []
  const enqueueNativeChildren = (value: Representation, childReason: string, parent: string | null = null): void => {
    const directSurfaces = objectSurfacesOf(value)
    if (directSurfaces.length > 0) {
      for (const surface of directSurfaces) work.push({ value: surface, reason: childReason, parent })
      return
    }
    const pending = [value]
    const pendingSeen = new Set<string>()
    while (pending.length > 0) {
      const next = pending.pop()
      if (!next) continue
      const identity = representationKey(next)
      if (pendingSeen.has(identity)) continue
      pendingSeen.add(identity)
      const surfaces = objectSurfacesOf(next)
      if (surfaces.length > 0) {
        for (const surface of surfaces) work.push({ value: surface, reason: childReason, parent })
      } else {
        const children = publishedChildrenCache.get(identity) ?? publishedChildrenOf(next, classes, deriver)
        publishedChildrenCache.set(identity, children)
        pending.push(...children)
      }
    }
  }
  enqueueNativeChildren(representation, reason)
  while (work.length > 0) {
    const item = work.pop()
    if (!item) continue
    const surfaces = objectSurfacesOf(item.value)
    for (const surface of surfaces) {
      const key = representationKey(surface)
      observe?.(key, item.parent)
      const row = rows.get(key) ?? { level: 'keys-only', reasons: new Set<string>(), representations: new Set<string>() }
      row.level = 'full'
      row.reasons.add(item.reason)
      row.representations.add(key)
      rows.set(key, row)
      // A base hook is needed to service the exposed descendant's inherited
      // fields. That support does not publish an arbitrary base instance and
      // therefore cannot expose sibling subclasses. Keep separate expansion
      // states: a later actual base escape must still visit its descendants.
      const expansion = `${item.inheritedProtocolOnly ? 'inherited' : 'instances'}:${key}`
      if (visited.has(expansion)) continue
      visited.add(expansion)
      if (surface.kind === 'class-ref') {
        for (const [declaration, layout] of classes) {
          if (declaration === surface.declaration || !layout.instance) continue
          if (extendsClass(classes, surface.declaration, declaration))
            work.push({
              value: layout.instance,
              reason: `${item.reason}:inherited-protocol`,
              parent: key,
              inheritedProtocolOnly: true
            })
          else if (!item.inheritedProtocolOnly && extendsClass(classes, declaration, surface.declaration))
            work.push({ value: layout.instance, reason: `${item.reason}:class-family`, parent: key })
        }
      }
      const identity = representationKey(surface)
      const children = publishedChildrenCache.get(identity) ?? publishedChildrenOf(surface, classes, deriver)
      publishedChildrenCache.set(identity, children)
      for (const child of children) enqueueNativeChildren(child, `${item.reason}:nested`, key)
    }
  }
}

const declaredFieldOf = (
  surface: Representation,
  key: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver | null
): RecordField | null => {
  if (deriver) {
    const field = declaredRecordFieldOf(deriver, surface, key, classes)
    if (field !== null) return field
  }
  if (surface.kind === 'record' || surface.kind === 'record-with-index') return surface.fields.find((field) => field.key === key) ?? null
  // `declaredRecordFieldOf` (`projection/fields.ts`) answers for `record`,
  // `record-with-index`, `class-ref` and `native-record-ref` -- it has no
  // case for `array-object` at all. An interface's own fields ADDED on top
  // of the Array it extends (`NodeArray<T> extends ReadonlyArray<T>,
  // ReadonlyTextRange` puts `pos`/`end`/`hasTrailingComma` on every node
  // list -- see `representation/model.ts`'s doc on `array-object.extension`)
  // therefore came back `null` from the deriver-first branch above whenever a
  // deriver was available, which is every real compilation, and every such
  // read fell through to the fully unrestricted `unproven-native-slot-value`
  // path even though the extension sidecar is exactly as closed a field list
  // as an ordinary record's. Fall back to the array's own sidecar, which the
  // deriver never had authority over in the first place.
  if (surface.kind === 'array-object') return surface.extension?.find((field) => field.key === key) ?? null
  return null
}

/**
 * A named GET off a surface `declaredFieldOf` HAS authority over
 * (`hasDeclaredFieldAuthority`) for a key that names no declared field,
 * method or accessor there, but that the language itself guarantees is
 * present through `Object.prototype` -- `.toString`, `.hasOwnProperty`,
 * `.constructor`, and the rest of `objectPrototypeMemberNames`
 * (`representation/record-fields.ts`, the identical closed list
 * `classFamilyLacksKey` already trusts to say a key is not a real absence).
 *
 * `knownNativeMemberReadOf` cannot answer this: it is deliberately restricted
 * to surfaces WITHOUT field authority, because for an authoritative surface a
 * *found* field whose carrier disagrees is a real defect that must keep its
 * promotion. This is a different sub-case -- the authority was asked and said
 * "no such OWN field, method or accessor" -- which is precisely what is true
 * of every ordinary object's inherited `Object.prototype` members: they are
 * never own fields, so no struct member could ever have named them, and the
 * struct's silence is not evidence of anything unproven. The result carrier
 * is the same evidence `knownNativeMemberReadOf` already leans on: a `get`
 * the checker resolved to a concrete, non-`any` type proves the read already
 * settled on a value nothing here needs to invent.
 *
 * A plain assignment cannot ever reach this (guarded by `operation.kind ===
 * 'get'` at the call site): shadowing one of these names with an own
 * property is a real write this proof does not cover, and stays unproven.
 */
const objectPrototypeMemberReadOf = (surface: Representation, key: string, value: Representation): boolean =>
  hasDeclaredFieldAuthority(surface) && objectPrototypeMemberNames.has(key) && value.kind !== 'dynamic' && value.kind !== 'unresolved'

/**
 * Whether `declaredRecordFieldOf` -- the authority `declaredFieldOf` delegates
 * to -- can answer about this surface's members AT ALL.
 *
 * It reads a record's own fields, a class's layout, and the shape behind a
 * `native-record-ref`. For every other native surface it returns null, and the
 * named-slot test below could not tell that answer apart from "this object has
 * no such member" -- so a member read off `Math`, an array, a typed array or a
 * Map was filed as an unproven slot value.
 */
const hasDeclaredFieldAuthority = (surface: Representation): boolean =>
  surface.kind === 'record' || surface.kind === 'record-with-index' || surface.kind === 'class-ref' || surface.kind === 'native-record-ref'

const primitiveLeaf = (representation: Representation): boolean =>
  representation.kind === 'undefined' ||
  representation.kind === 'null' ||
  representation.kind === 'scalar' ||
  representation.kind === 'string'

/**
 * A read result that can hold no object, so it publishes none. The frame
 * census types `arguments[ 100 ]` exactly `undefined` when no closed caller
 * fills that position; the element such a read never returns owes no protocol.
 */
const holdsNoObject = (representation: Representation): boolean => {
  if (representation.kind === 'optional') return primitiveLeaf(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => primitiveLeaf(arm.value))
  return primitiveLeaf(representation)
}

/**
 * A read of a declared member off a native surface no field authority covers.
 *
 * This is `knownClassMemberReadOf`'s argument, made available to the carriers
 * that have no `ClassLayout` to consult: reading a member the carrier declares
 * hands back that member's own carrier, so the read proves nothing is unproven
 * -- it publishes no field of the receiver, and the value it produces is the
 * one the declaration already stated.
 *
 * The evidence that the key names a declared member is the RESULT CARRIER. A
 * key naming nothing on a typed receiver is typed `any` by the checker and
 * arrives here as `dynamic`, and a member the representation layer could not
 * resolve arrives as `unresolved`; either one keeps the promotion. Receivers
 * that are themselves dynamic never reach this test at all, because
 * `objectSurfacesOf` yields them no surface.
 *
 * Restricted to surfaces with no field authority ON PURPOSE. Where one exists
 * and says the declared carrier differs from the value's, that is a real
 * carrier disagreement about storage the compiler owns, and it must keep its
 * promotion; this answers only the case where nothing was ever asked.
 *
 * What this cost: `Object.defineProperty` read off `ObjectConstructor` returns
 * a callable whose signature the checker instantiated with `Material`, and
 * promoting that callable walks its ABI -- so reading the member promoted the
 * class in its signature. The three.js app had ~1,350 such reads.
 */
const knownNativeMemberReadOf = (surface: Representation, key: string, value: Representation): boolean =>
  !hasDeclaredFieldAuthority(surface) &&
  !(surface.kind === 'array-object' && canonicalIndexLiteral(key) !== null) &&
  value.kind !== 'dynamic' &&
  value.kind !== 'unresolved'

const knownClassMemberReadOf = (surface: Representation, key: string, classes: ReadonlyMap<DeclarationId, ClassLayout>): boolean => {
  if (surface.kind !== 'class-ref') return false
  const seen = new Set<DeclarationId>()
  let declaration: DeclarationId | null = surface.declaration
  while (declaration !== null && !seen.has(declaration)) {
    seen.add(declaration)
    const layout = classes.get(declaration)
    if (!layout) return false
    if (layout.methods.some((member) => member.key === key) || layout.accessors.some((member) => member.key === key)) return true
    if (layout.fields.some((member) => member.key === key)) return false
    declaration = layout.base
  }
  return false
}

/**
 * Sealed reflection exposure census. Every emitted candidate is seeded as
 * `keys-only`; only dynamic/unknown boundaries promote it to `full`.
 */
export const reflectionExposureOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver | null,
  options: ReflectionExposureOptions
): ReflectionExposure => {
  const rows = new Map<string, { level: ReflectionDemandLevel; reasons: Set<string>; representations: Set<string> }>()
  const directChildrenCache = new Map<string, readonly Representation[]>()
  const publishedChildrenCache = new Map<string, readonly Representation[]>()
  const propertyLayoutCache = new Map<string, boolean>()
  const nativePropertyLayoutOf = (representation: Representation): boolean =>
    hasNativePropertyLayout(representation, deriver, classes, new Set<string>(), propertyLayoutCache)
  const certifiedComputedReadOf = (operation: IrOperation): boolean => {
    if (operation.kind !== 'get' || operation.typedComputedRead?.kind !== 'closed-record') return false
    return (
      operation.receiver.representation.kind === 'record' &&
      operation.typedComputedRead.receiver === representationKey(operation.receiver.representation) &&
      operation.typedComputedRead.result === representationKey(operation.result.representation)
    )
  }
  const expandedFull = new Set<string>()
  const unrestricted = new Set<string>()
  const fieldOperations = new Map<string, Map<string, Set<ReflectionFieldOperation>>>()
  const origins: { readonly reason: string; readonly carrier: Representation; readonly operation: IrOperation | null }[] = []
  const affecting = new Map<string, Set<number>>()
  const parents = new Map<string, Set<string>>()
  let currentOperation: IrOperation | null = null
  const promoteFull = (representation: Representation, reason: string, carrier = representation): void => {
    const origin = origins.length
    if (options.trace) origins.push({ reason, carrier, operation: currentOperation })
    const observe = (key: string, parent: string | null): void => {
      unrestricted.add(key)
      if (!options.trace) return
      const entries = affecting.get(key) ?? new Set<number>()
      entries.add(origin)
      affecting.set(key, entries)
      if (parent !== null) {
        const sources = parents.get(key) ?? new Set<string>()
        sources.add(parent)
        parents.set(key, sources)
      }
    }
    promote(rows, representation, reason, classes, deriver, expandedFull, publishedChildrenCache, observe)
  }
  /**
   * Retain the protocol for this surface itself without claiming that its
   * fields/children are dynamically published.  A sealed Array/Map/callable
   * field can require its own hooks while the containing class is accessed
   * only through fixed native slots; propagating the layout-proof failure into
   * every child would turn that independent demand into a false escape.
   * Actual dynamic reads, calls, conversions and publications continue to use
   * `promoteFull`, which closes the entire reachable carrier graph.
   */
  const markFullOnly = (representation: Representation, reason: string): void => {
    const pending = [representation]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const value = pending.pop()
      if (!value) continue
      const identity = representationKey(value)
      if (seen.has(identity)) continue
      seen.add(identity)
      const surfaces = objectSurfacesOf(value)
      if (surfaces.length > 0) {
        for (const surface of surfaces) {
          const key = representationKey(surface)
          const row = rows.get(key) ?? { level: 'keys-only', reasons: new Set<string>(), representations: new Set<string>() }
          row.level = 'full'
          row.reasons.add(reason)
          unrestricted.add(key)
          row.representations.add(key)
          rows.set(key, row)
        }
        continue
      }
      const children = publishedChildrenCache.get(identity) ?? publishedChildrenOf(value, classes, deriver)
      publishedChildrenCache.set(identity, children)
      pending.push(...children)
    }
  }
  /**
   * A `ClassName.KEY` slot the whole-program static-field census gave native
   * storage of exactly this carrier.
   *
   * `declaredFieldOf` has no answer for a `constructor-family`: a class layout
   * records the static fields a class BODY declares, and the dominant static
   * idiom in ordinary JavaScript writes them from module scope instead
   * (`Color.NAMES = _colorKeywords`, `Object3D.DEFAULT_UP = ...`). Reading that
   * silence as "this key names no slot" promoted the assigned VALUE to a full
   * dynamic field protocol -- 296 boxes for the colour-keyword table alone,
   * from one assignment -- while the target was already storing it in a typed
   * `gea::Ref` global with no `gea::Value` anywhere in sight.
   *
   * The census is the authority that publishes that storage, so it is what
   * gets asked, rather than a shape test invented here that could disagree
   * with the slot actually emitted. It refuses a computed key, a key no
   * `constant` accounts for, a static method or accessor, and any pair of
   * writes whose carriers disagree -- so a slot it answers for is one carrier,
   * fixed, and the equality below is the whole proof.
   */
  const staticFieldSlots = censusClassStaticFieldSlots(bodies, classes)
  const nativeStaticSlotHolds = (receiver: Representation, key: string, value: Representation | null): boolean => {
    if (value === null) return false
    if (receiver.kind === 'optional') return nativeStaticSlotHolds(receiver.payload, key, value)
    if (receiver.kind === 'borrowed-ref') return nativeStaticSlotHolds(receiver.referent, key, value)
    if (receiver.kind !== 'constructor-family') return false
    const slot = staticFieldSlotOf(staticFieldSlots, classes, receiver.members, key)
    return slot !== null && representationKey(slot) === representationKey(value)
  }
  const promoteNamedField = (receiver: Representation, key: string, operation: IrOperation): void => {
    const origin = origins.length
    if (options.trace) origins.push({ reason: 'named-field-operation', carrier: receiver, operation })
    const surfaces = new Map(objectSurfacesOf(receiver).map((surface) => [representationKey(surface), surface]))
    for (const surface of [...surfaces.values()]) {
      if (surface.kind !== 'class-ref') continue
      for (const layout of classes.values())
        if (
          layout.instance &&
          (extendsClass(classes, surface.declaration, layout.declaration) || extendsClass(classes, layout.declaration, surface.declaration))
        )
          surfaces.set(representationKey(layout.instance), layout.instance)
    }
    for (const [identity, surface] of surfaces) {
      const row = rows.get(identity) ?? { level: 'keys-only', reasons: new Set<string>(), representations: new Set<string>() }
      row.level = 'full'
      row.reasons.add('named-field-operation')
      row.representations.add(identity)
      rows.set(identity, row)
      const fields = fieldOperations.get(identity) ?? new Map<string, Set<ReflectionFieldOperation>>()
      const uses = fields.get(key) ?? new Set<ReflectionFieldOperation>()
      const nativeReflect =
        operation.kind === 'call'
          ? nativeReflectFieldTransportOf(operation, declaredFieldOf(surface, key, classes, deriver), deriver)
          : null
      if (nativeReflect) uses.add(nativeReflect)
      else if (
        operation.kind === 'get' ||
        (operation.kind === 'compute' && operation.operator === 'ObjectTag') ||
        (operation.kind === 'call' &&
          (operation.intrinsicReflection === 'get' || operation.intrinsicReflection === 'getOwnPropertyDescriptor'))
      )
        uses.add('read')
      else if (operation.kind === 'set' || (operation.kind === 'call' && operation.intrinsicReflection === 'set')) uses.add('write')
      else if (operation.kind === 'define-own-property') uses.add('define')
      fields.set(key, uses)
      fieldOperations.set(identity, fields)
      if (options.trace) {
        const entries = affecting.get(identity) ?? new Set<number>()
        entries.add(origin)
        affecting.set(identity, entries)
      }
      // A named read can publish that field's object, never every sibling's.
      if (
        operation.kind === 'get' ||
        (operation.kind === 'call' &&
          (operation.intrinsicReflection === 'get' || operation.intrinsicReflection === 'getOwnPropertyDescriptor') &&
          nativeReflect === null)
      ) {
        const field = declaredFieldOf(surface, key, classes, deriver)
        if (field) promoteFull(field.value, 'named-field-result')
        else if (
          surface.kind === 'array-object' &&
          canonicalIndexLiteral(key) !== null &&
          operation.result !== null &&
          !holdsNoObject(operation.result.representation)
        )
          promoteFull(surface.element, 'indexed-array-field-result')
      }
    }
  }
  const carriesCallable = (representation: Representation, seen = new Set<string>()): boolean => {
    const identity = representationKey(representation)
    if (seen.has(identity)) return false
    seen.add(identity)
    if (
      callableAbiOf(representation) !== null ||
      representation.kind === 'constructor-family' ||
      representation.kind === 'constructor-value-dispatch'
    )
      return true
    if (objectSurfacesOf(representation).length > 0) return false
    const children = directChildrenCache.get(identity) ?? directChildrenOf(representation, classes, deriver)
    directChildrenCache.set(identity, children)
    return children.some((child) => carriesCallable(child, seen))
  }
  const candidates = new Map<string, Representation>()
  // A retained function value can be inspected without its body ever running.
  // Use the callable census's complete entry/escape result, recomputed for this
  // exact program, rather than treating allocation as execution or trusting a
  // stale flag attached before another caller was added. Layout and ABI lookup
  // below still retain every body; only impossible execution contributes no
  // dynamic-operation demand.
  const callableReads: { operation: Extract<IrOperation, { kind: 'get' }>; reason: string }[] = []
  const enteredBodies = options.shakeComplete
    ? nativeCallableFlowOf(
        bodies,
        options.placements ?? new Map(),
        classes,
        options.conversions,
        options.trace ? (operation, reason) => callableReads.push({ operation, reason }) : undefined,
        deriver
      ).enteredBodies
    : null
  const operations = bodies
    .filter((body) => enteredBodies === null || enteredBodies.has(body.owner))
    .flatMap((body) =>
      body.blockOrder.flatMap((blockId) => {
        const block = body.blocks.get(blockId)
        return block ? [...block.operations, block.terminator] : []
      })
    )
  // `GEA_REFLECTION_DEBUG=<representation-key substring>` names, on stderr,
  // every body the callable flow left un-entered (so its operations count for
  // no demand at all) and the final row of every surface whose key contains
  // the substring. A struct emitted WITHOUT the own-field protocol while an
  // emitted body deletes or writes an expando on it is exactly this pair
  // disagreeing, and neither side says so on its own: the emitter renders the
  // body because reachability kept it, the census skipped it because the flow
  // never saw a call enter it.
  const reflectionWatch = process.env.GEA_REFLECTION_DEBUG
  if (reflectionWatch !== undefined && enteredBodies !== null)
    for (const body of bodies)
      if (!enteredBodies.has(body.owner))
        console.error(`[REFLECTION-UNENTERED] source=${String(body.sourceOwner)} owner=${String(body.owner)}`)
  // A template-backed intrinsic does not materialize its callee as a JS
  // callable. Do not infer a publication of the intrinsic ABI's return type
  // from a value used exclusively by sealed native definitions.
  // lower-invocation publishes intrinsicReflection only for an authenticated
  // template callee. Its actual field effects are handled below; its unused
  // function-value ABI cannot expose the descriptor that template constructs.
  const nativeTemplateCallee = (operation: IrOperation): boolean =>
    operation.kind === 'call' &&
    (operation.fixedDataDefinition?.nativeFieldProtocol === 'unused' || operation.intrinsicReflection !== undefined)
  const nativeDefinitionCallees = new Set<IrValueId>()
  for (const operation of operations)
    if (operation.kind === 'call' && nativeTemplateCallee(operation)) nativeDefinitionCallees.add(operation.callee.value)
  for (const operation of operations)
    for (const operand of operandsOfIrOperation(operation))
      if (!(
        operation.kind === 'call' &&
        nativeTemplateCallee(operation) &&
        operand.value === operation.callee.value &&
        operation.receiver?.value !== operand.value &&
        !operation.arguments.some((argument) => argument.value === operand.value)
      ))
        nativeDefinitionCallees.delete(operand.value)
  // `options.representations` is the complete sealed plan, including ABI
  // entries whose callable object was shaken away.  A callable ABI is an
  // external publication boundary only when a final IR value actually
  // carries it.  Results and operands cover allocation, parameter/binding,
  // field, call, return, capture and conversion paths; a body ABI alone is
  // intentionally not evidence that its function object escaped.
  const materializedRepresentations = new Set<string>()
  const observedValues = new Set<IrValueId>()
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result && !nativeDefinitionCallees.has(result.id)) materializedRepresentations.add(representationKey(result.representation))
    for (const operand of operandsOfIrOperation(operation)) {
      if (!nativeDefinitionCallees.has(operand.value)) materializedRepresentations.add(representationKey(operand.representation))
      observedValues.add(operand.value)
    }
  }
  const bodyByFunction = new Map<string, IrBody | null>()
  const bodyByOperation = new Map<IrOperation, IrBody>()
  for (const body of bodies) {
    for (const block of body.blocks.values())
      for (const operation of [...block.operations, block.terminator]) bodyByOperation.set(operation, body)
    if (body.abi === null) continue
    const key = String(body.sourceOwner)
    bodyByFunction.set(key, bodyByFunction.has(key) ? null : body)
  }
  const knownCallFunctionIds = (operation: Extract<IrOperation, { readonly kind: 'call' }>): readonly FunctionId[] | null => {
    if (operation.argumentsAreSpread || operation.closedCallee === undefined) return null
    return operation.closedCallee.kind === 'exact' ? [operation.closedCallee.functionId] : operation.closedCallee.functionIds
  }
  const closedCallOperations = new Set<IrOperation>()
  for (const operation of operations) {
    if (operation.kind !== 'call') continue
    const functionIds = knownCallFunctionIds(operation)
    if (
      functionIds === null ||
      functionIds.length === 0 ||
      !functionIds.every((functionId) => {
        const body = bodyByFunction.get(String(functionId))
        return (
          body !== undefined &&
          body !== null &&
          body.abi !== null &&
          (operation.closedFrame === undefined ? callMatchesAbi(operation, body.abi) : abiMatches(operation.closedFrame.abi, body.abi))
        )
      })
    )
      continue
    closedCallOperations.add(operation)
  }
  const closedConstructOperations = new Set<IrOperation>()
  for (const operation of operations) {
    if (operation.kind !== 'construct') continue
    if (nativeClassConstructionOf(operation, classes, (id) => bodyByFunction.get(String(id)), options.conversions) !== null) {
      closedConstructOperations.add(operation)
      continue
    }
    // A host constructor has no compiler-owned body for the loop below to
    // walk, so its frame is the whole proof, exactly as for a sealed native
    // call: `new WeakMap()` in three's `WebGLProperties` publishes a fresh
    // empty collection, not the texture/material bags it will later hold.
    // See `nativeHostConstructionOf` for what stays open.
    if (nativeHostConstructionOf(operation, options.conversions) !== null) {
      closedConstructOperations.add(operation)
      continue
    }
    const targets =
      operation.target.kind === 'exact'
        ? [operation.target.target]
        : operation.target.kind === 'closed-family'
          ? operation.target.targets
          : null
    if (targets === null || targets.length === 0) continue
    let closed = true
    for (const target of targets) {
      if (target.kind === 'function') {
        const body = bodyByFunction.get(String(target.functionId))
        const classLayouts = [...classes.values()].filter((layout) => layout.constructor === target.functionId)
        if (body === undefined || body === null) {
          closed = false
          break
        }
        if (classLayouts.length > 0) {
          // Written class constructors use the class body ABI (`this`/
          // instance receiver, void result), while the class allocation owns
          // the receiver-less construct ABI used by this operation.
          if (
            !classLayouts.every(
              (layout) =>
                layout.construct !== null &&
                constructMatchesAbi(operation, layout.construct, options.conversions) &&
                classConstructorBodyMatches(layout, body)
            )
          ) {
            closed = false
            break
          }
          continue
        }
        // The entry census can also publish a receiver-free call convention
        // when the ordinary constructor's explicit Object return always wins.
        // Reflection must consume the same entry the printer will invoke.
        const entry = operation.entry
        const constructAbi =
          entry?.kind === 'explicit-object-return' &&
          entry.functionId === target.functionId &&
          body.abi !== null &&
          abiMatches(entry.abi, body.abi)
            ? entry.abi
            : body.construct
        if (!target.constructable || constructAbi === null || !constructMatchesAbi(operation, constructAbi, options.conversions)) {
          closed = false
          break
        }
        continue
      }
      const layout = classLayoutOfCopy(classes, target.classDeclaration)
      // An implicit-source-constructor target is emitted only for a class with
      // no written constructor.  Its class construct ABI is the complete
      // convention; accepting a layout that also names a constructor would
      // silently bypass that body and turn a closed result into a guess.
      if (
        layout === undefined ||
        layout.constructor !== null ||
        layout.construct === null ||
        !constructMatchesAbi(operation, layout.construct, options.conversions)
      ) {
        closed = false
        break
      }
    }
    if (closed) closedConstructOperations.add(operation)
  }
  const unwrappedCallableAbi = (representation: Representation): CallableAbi | null => {
    if (representation.kind === 'optional') return unwrappedCallableAbi(representation.payload)
    if (representation.kind === 'borrowed-ref') return unwrappedCallableAbi(representation.referent)
    return callableAbiOf(representation)
  }
  // An adapter invokes a compiler-owned source body through its own sealed
  // convention. Its FunctionId alone cannot certify the adapted call frame;
  // follow the conversion's transport proof and check the held entry instead.
  //
  // The frame is the whole proof here, and `closedValue` is deliberately not
  // required beside it. Naming a compiler-owned body is what DISPATCH needs;
  // what this census needs is whether the operands cross a dynamic boundary,
  // and an exact frame already answers that: every argument, the receiver and
  // the result agree with the callee's own stated convention, so each one is
  // held in its declared native carrier and none is published as a `Value`.
  // Requiring a FunctionId beside it asked a question a sealed native member
  // can never answer -- `CallOperation.closedCallee` names "compiler-owned
  // body identity only" -- so `[].push(n)`, `map.get(k)`, `str.split(s)`,
  // `Math.min(a, b)` and `pattern.exec(s)` each read as an open boundary and
  // promoted their receiver and every argument to an unrestricted field
  // protocol. That was 2,480 of the three.js app's 4,193 `unknown-call-boundary`
  // origins, every one of them with a frame that already matched exactly.
  //
  // A callee stating no native convention still fails `abi !== null` -- a
  // `dynamic` callee has no ABI to match -- an inexact frame still fails, and
  // a compiler-owned body contributes its own operations to this same census
  // whether or not a call site names it. So nothing here trusts a body it has
  // not walked; it trusts the convention the carrier already states.
  for (const operation of operations) {
    if (operation.kind !== 'call' || operation.argumentsAreSpread || closedCallOperations.has(operation)) continue
    // A call the printer spells from a host template never enters the callee's
    // declared convention, so that convention is not its frame; the template's
    // own is (`hostTemplateFrameOf`), and where it answers it alone decides.
    const template = hostTemplateFrameOf(operation, options.conversions, deriver, classes)
    if (template !== undefined) {
      if (template) closedCallOperations.add(operation)
      continue
    }
    const abi = unwrappedCallableAbi(operation.callee.representation)
    // `native-transfer`, not the value identity provenance and the native
    // class-initialization entry ask for: this census's question is whether an
    // operand crosses a dynamic boundary, and an argument the conversion census
    // carries into its formal in native storage crosses none, whoever's value
    // the body ends up holding.
    if (abi !== null && nativeCallFrameOf(operation, abi, observedValues, options.conversions, 'native-transfer') !== undefined)
      closedCallOperations.add(operation)
  }
  const collectCandidate = (representation: Representation): readonly Representation[] => {
    const rootKey = representationKey(representation)
    const descendants: Representation[] = []
    const descendantKeys = new Set<string>()
    const pending = [representation]
    const pendingSeen = new Set<string>()
    while (pending.length > 0) {
      const next = pending.pop()
      if (!next) continue
      const identity = representationKey(next)
      if (pendingSeen.has(identity)) continue
      pendingSeen.add(identity)
      const surfaces = objectSurfacesOf(next)
      if (surfaces.length > 0) {
        for (const surface of surfaces) {
          const key = representationKey(surface)
          if (key !== rootKey && !descendantKeys.has(key)) {
            descendantKeys.add(key)
            descendants.push(surface)
          }
          if (candidates.has(key)) continue
          candidates.set(key, surface)
          // Candidate discovery must publish a row even when this nested
          // surface never appears as a separate root in the emission inventory.
          // A missing row makes consumers retain the unrestricted protocol.
          if (!rows.has(key)) rows.set(key, { level: 'keys-only', reasons: new Set(), representations: new Set([key]) })
          if (!nativePropertyLayoutOf(surface)) markFullOnly(surface, 'unproven-layout-protocol')
          const children = directChildrenCache.get(key) ?? directChildrenOf(surface, classes, deriver)
          directChildrenCache.set(key, children)
          pending.push(...children)
        }
      } else {
        const children = directChildrenCache.get(identity) ?? directChildrenOf(next, classes, deriver)
        directChildrenCache.set(identity, children)
        pending.push(...children)
      }
    }
    return descendants
  }
  const seededRoots = new Set<string>()
  for (const representation of options.representations) {
    const identity = representationKey(representation)
    if (seededRoots.has(identity)) continue
    seededRoots.add(identity)
    const surfaces = objectSurfacesOf(representation)
    if (surfaces.length === 0) {
      if (!materializedRepresentations.has(identity)) continue
      // Inventory includes both sides of the convention. Publication follows
      // the outgoing side only; an input type is not an exposed object.
      for (const child of collectCandidate(representation)) {
        const key = representationKey(child)
        const row = rows.get(key) ?? { level: 'keys-only', reasons: new Set<string>(), representations: new Set<string>() }
        row.representations.add(key)
        if (!nativePropertyLayoutOf(child)) {
          row.level = 'full'
          row.reasons.add('unproven-layout-protocol')
          markFullOnly(child, 'unproven-layout-protocol')
        }
        rows.set(key, row)
      }
      // A signature is an inventory entry, not an outgoing object. Calls,
      // conversions and publications below own demand for callable outputs;
      // even an unknown callable can be discarded without creating its result.
      if (!isDeferredCarrier(representation)) promoteFull(representation, 'unproven-carrier-boundary')
    }
    for (const surface of surfaces) {
      collectCandidate(surface)
      const key = representationKey(surface)
      const row = rows.get(key) ?? { level: 'keys-only', reasons: new Set<string>(), representations: new Set<string>() }
      row.representations.add(key)
      if (!nativePropertyLayoutOf(surface)) {
        row.level = 'full'
        row.reasons.add('unproven-layout-protocol')
      }
      rows.set(key, row)
      if (!nativePropertyLayoutOf(surface)) markFullOnly(surface, 'unproven-layout-protocol')
    }
  }
  const constants = constantsOf(operations)
  const typedReturnValues = new Set<string>()
  for (const body of bodies) {
    // The body publishes its exact native ABI result. How callers expose it
    // is owned by their call/conversion operations, including unknown calls;
    // requiring a known direct invocation here conflates those boundaries.
    if (body.abi === null) continue
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (block?.terminator.kind === 'return' && block.terminator.value !== null && body.abi.result.kind !== 'void') {
        if (representationKey(block.terminator.value.representation) === representationKey(body.abi.result))
          typedReturnValues.add(String(block.terminator.value.value))
      }
    }
  }
  for (const operation of operations) {
    currentOperation = operation
    if (operation.kind === 'compute' && operation.form === 'unary' && operation.operator === 'ObjectTag') {
      // The authenticated algorithm reads one well-known symbol. It neither
      // reads ordinary toString nor publishes unrelated fields or tag objects.
      const tagDeclaration = [...(options.wellKnownSymbols ?? [])].find(([, name]) => name === 'toStringTag')?.[0]
      const receiver = operation.operands[0]
      if (tagDeclaration !== undefined && receiver !== undefined) {
        if (deriver && nativeRecordIndexHasPropertyOf(deriver, receiver.representation, { kind: 'symbol' })) continue
        promoteNamedField(receiver.representation, `sym(${tagDeclaration})`, operation)
        continue
      }
      // Without the symbol census, retain the ordinary unknown-operation
      // demand below: an absent authority is not proof of an absent property.
    }
    if (operation.kind === 'get' && nativeDefinitionCallees.has(operation.result.id)) continue
    if (nativeAbsentPropertyReadOf(operation) !== null) continue
    if (nativeKeyQueryOf(operation, nativePropertyLayoutOf)) continue
    if (nativeArrayTransportOf(operation, keyOf(keyOperandOf(operation), constants))) continue
    if (nativeDictionaryTransportOf(operation)) continue
    if (nativeRecordIndexTransportOf(operation, deriver, options.conversions, keyOf(keyOperandOf(operation), constants))) continue
    if (nativeSequenceTransportOf(operation)) continue
    if (nativeCallableBindTransportOf(operation)) continue
    if (
      nativeClassAccessorEntryOf(
        operation,
        keyOf(keyOperandOf(operation), constants),
        classes,
        (id) => bodyByFunction.get(String(id)),
        options.conversions
      )
    )
      continue
    if ((operation.kind === 'get' || operation.kind === 'set') && operation.receiver.representation.kind === 'class-ref') {
      const key = keyOf(operation.key, constants)
      const member = key === null ? null : classMemberOf(classes, operation.receiver.representation.declaration, key)
      if (member?.kind === 'accessor') {
        // The native entry proof above owns safe accessor transport. An
        // adapting/unknown half must retain both its receiver and its actual
        // payload convention, even if the get result itself is erased.
        promoteFull(operation.receiver.representation, 'unproven-accessor-entry')
        const id = operation.kind === 'get' ? member.accessor.getter : member.accessor.setter
        const frame = id === null ? null : bodyByFunction.get(String(id))?.abi
        if (operation.kind === 'get') {
          if (frame) promoteFull(frame.result, 'unproven-accessor-result')
          promoteFull(operation.result.representation, 'unproven-accessor-result')
        } else {
          promoteFull(operation.value.representation, 'unproven-accessor-argument')
          for (const parameter of frame?.parameters ?? []) promoteFull(parameter.value, 'unproven-accessor-argument')
        }
        continue
      }
    }
    if (operation.kind === 'merge-live-arm-rebuild' && options.conversions && nativeMergeTransportMatches(operation, options.conversions))
      continue
    const receiver = receiverOf(operation)
    if (receiver) {
      const key = keyOf(keyOperandOf(operation), constants)
      // A computed key three's `Material.setValues`/`Texture.setValues` shape
      // hands the census a finite, closed-forward name set for
      // (`PropertyOperation.provenKeyTexts`'s own comment has the full
      // contract) is an UPPER bound on the key, proven from every closed
      // caller and checked against the sealed host-mutation census's own
      // obligations -- never license to assume more than that proof. `null`
      // here (no hook, a refused proof, or a surviving-obligation check that
      // failed) means exactly what it meant before this field existed:
      // publish the whole reachable carrier graph.
      const provenKeyTexts =
        (operation.kind === 'get' || operation.kind === 'set') && operation.provenKeyTexts && operation.provenKeyTexts.length > 0
          ? operation.provenKeyTexts
          : null
      if (
        key === null &&
        operation.kind !== 'own-property-keys' &&
        !(operation.kind === 'get-iterator' && operation.protocol === 'enumerate') &&
        !certifiedComputedReadOf(operation)
      ) {
        if (provenKeyTexts) {
          // `promoteNamedField` already fans a `class-ref` receiver out across
          // its whole family (bases and subclasses) -- exactly what a key
          // that can name a member declared on ANY of them needs: `this` is
          // typed `Material` but `color`/`shininess` are declared only on
          // `MeshPhongMaterial`.
          for (const name of provenKeyTexts) promoteNamedField(receiver.representation, name, operation)
        } else promoteFull(receiver.representation, 'runtime-computed-property-key')
      } else if (key !== null && operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'define-own-property')
        promoteNamedField(receiver.representation, key, operation)
      else if (key !== null) {
        const value = valueRepresentationOf(operation)
        const surfaces = objectSurfacesOf(receiver.representation)
        // A `constructor-family` has no object SURFACE at all -- no struct, so
        // nothing for a field protocol to be published on -- which is why the
        // surface walk below cannot reach it and why its slot proof is asked of
        // the receiver itself.
        // A non-default descriptor is never a native slot write, whatever the
        // carriers say -- see `storesIntoDeclaredSlot` -- so the exact-carrier
        // and static-slot proofs below are asked only of a write that takes the
        // ordinary member store.
        const exact =
          value !== null &&
          !(operation.kind === 'define-own-property' && !storesIntoDeclaredSlot(operation)) &&
          (nativeStaticSlotHolds(receiver.representation, key, value) ||
            (operation.kind === 'get' && classPrototypeReadOf(classes, receiver.representation, key, value) !== null) ||
            (surfaces.length > 0 &&
              surfaces.every((surface) => {
                const field = declaredFieldOf(surface, key, classes, deriver)
                return (
                  (field !== null &&
                    (representationKey(field.value) === representationKey(value) ||
                      (operation.kind === 'get' &&
                        nativePayloadTransportMatches(
                          field.value,
                          value,
                          options.conversions?.nodeById(conversionNodeIdOf(field.value, value))
                        )) ||
                      (storesIntoDeclaredSlot(operation) &&
                        nativePayloadTransportMatches(
                          value,
                          field.value,
                          options.conversions?.nodeById(conversionNodeIdOf(value, field.value))
                        )))) ||
                  (operation.kind === 'get' &&
                    (knownClassMemberReadOf(surface, key, classes) ||
                      knownNativeMemberReadOf(surface, key, value) ||
                      absentClassArmRead(receiver.representation, surface, key, value, classes) ||
                      objectPrototypeMemberReadOf(surface, key, value)))
                )
              })))
        if (!exact) {
          promoteNamedField(receiver.representation, key, operation)
          if (value) promoteFull(value, 'unproven-native-slot-value')
        }
      }
      continue
    }
    if (operation.kind === 'convert' && operation.result.representation.kind === 'dynamic') {
      promoteFull(operation.source.representation, 'object-to-dynamic-conversion')
      continue
    }
    if (operation.kind === 'convert') {
      const node = options.conversions?.nodeById(operation.conversionUse)
      if (
        node !== null &&
        node !== undefined &&
        representationKey(node.source) === representationKey(operation.source.representation) &&
        representationKey(node.target) === representationKey(operation.result.representation) &&
        (node.capability.kind === 'identity' ||
          ((node.capability.kind === 'atom' || node.capability.kind === 'static' || node.capability.kind === 'class-family') &&
            node.capability.materializer.nativeFieldProtocol === 'unused'))
      )
        continue
      // A converted callable receives the target convention's inputs. Unless
      // the conversion proved native-only transport above, its adapter may
      // publish those inputs to a dynamic source listener. That publication
      // happens inside generated adapter code, not in a separate IR call.
      const targetAbi = unwrappedCallableAbi(operation.result.representation)
      // Under `GEA_REFLECTION_DEBUG`, the site too: a row's reasons say WHAT
      // was promoted, and an adapter's cost is only removable at the
      // conversion that installs it.
      if (reflectionWatch !== undefined && targetAbi !== null)
        console.error(
          `[REFLECTION-ADAPTER] lineage=${String(operation.lineage)} node=${operation.conversionUse} capability=${node?.capability.kind ?? 'none'}`
        )
      if (targetAbi !== null) {
        if (targetAbi.receiver !== null) promoteFull(targetAbi.receiver, 'callable-adapter-input')
        for (const parameter of targetAbi.parameters) promoteFull(parameter.value, 'callable-adapter-input')
      }
    }
    if (observesNativeCarrierOnly(operation)) continue
    if (
      operation.kind === 'phi' &&
      operation.incoming.every(
        (incoming) => representationKey(incoming.value.representation) === representationKey(operation.result.representation)
      )
    )
      continue
    // A representation-preserving conversion is a typed identity transfer.
    // It does not invoke a native dynamic protocol, even when the source and
    // destination are borrowed/optional wrappers around the same carrier.
    // Other conversions stay at the generic boundary below until their
    // conversion authority publishes a stronger closed proof.
    if (
      operation.kind === 'convert' &&
      representationKey(operation.source.representation) === representationKey(operation.result.representation)
    )
      continue
    if (operation.kind === 'spread-copy') {
      promoteFull(operation.source.representation, 'dynamic-spread-source')
      promoteFull(operation.receiver.representation, 'dynamic-spread-target')
      continue
    }
    if (operation.kind === 'call') {
      if (operation.intrinsicReflection && !operation.argumentsAreSpread) {
        const target = operation.arguments[0]
        const property = operation.arguments[1]
        if (target && property) {
          // Native ABI transport does not erase Reflect's actual field access.
          const key = keyOf(property, constants)
          if (key === null) promoteFull(target.representation, 'reflect-runtime-key')
          else promoteNamedField(target.representation, key, operation)
          promoteFull(property.representation, 'reflect-key-coercion')
          if (operation.intrinsicReflection === 'set' && operation.arguments[2]) {
            const surfaces = objectSurfacesOf(target.representation)
            const native =
              key !== null &&
              surfaces.length > 0 &&
              surfaces.every(
                (surface) => nativeReflectFieldTransportOf(operation, declaredFieldOf(surface, key, classes, deriver)) === 'native-write'
              )
            if (!native) promoteFull(operation.arguments[2].representation, 'reflect-written-value')
          }
          continue
        }
      }
      if (operation.fixedDataDefinition !== undefined) {
        if (operation.fixedDataDefinition.nativeFieldProtocol === 'unused') continue
        // The recipe explicitly records missing authentication or a conversion
        // that needs native field reflection. A matching ABI cannot cancel it.
        for (const value of operandsOfIrOperation(operation)) promoteFull(value.representation, 'unproven-fixed-data-definition')
        if (operation.result) promoteFull(operation.result.representation, 'unproven-fixed-data-definition-result')
        continue
      }
      // A call that reads only its argument's carrier exposes nothing inside
      // it. `Array.isArray` is the whole family so far; its ambient parameter
      // is `any`, which is why it otherwise reads here as the most open
      // boundary a program can have.
      if (nativeCarrierPredicateOf(operation)) continue
      // CallOperation has no authenticated host-path fact. Unknown calls may
      // inspect or mutate every native receiver/argument they receive.
      // A matching call elsewhere cannot certify this operation's ABI.
      if (closedCallOperations.has(operation)) continue
      // A native fixed frame cannot inspect trailing arguments it does not
      // receive. Their evaluation is already represented by preceding IR;
      // retaining its effects does not publish the resulting values here.
      for (const value of [operation.callee, operation.receiver, ...receivedCallArguments(operation)])
        if (value) promoteFull(value.representation, 'unknown-call-boundary')
      if (operation.result) promoteFull(operation.result.representation, 'unknown-call-result')
      continue
    }
    if (operation.kind === 'construct' && closedConstructOperations.has(operation)) continue
    if (
      operation.kind === 'super-initialize' &&
      nativeSuperInitializationOf(
        operation,
        bodyByOperation.get(operation),
        classes,
        (id) => bodyByFunction.get(String(id)),
        options.conversions
      ) !== null
    )
      continue
    if (operation.kind === 'construct') {
      // The fresh object is an output boundary just like an unknown call's
      // result.  It is not listed by operandsOfIrOperation because construct
      // operands intentionally exclude the result value.
      promoteFull(operation.result.representation, 'unknown-operation-boundary:construct-result')
    }
    if (operation.kind === 'binding-write') {
      const placement = options.placements?.get(operation.declaration)
      const local = placement?.storage.kind === 'local' || placement?.storage.kind === 'region'
      if (
        !local ||
        placement?.representation === null ||
        placement === undefined ||
        representationKey(placement.representation) !== representationKey(operation.value.representation)
      )
        promoteFull(operation.value.representation, 'unproven-binding-publication')
      continue
    }
    if (operation.kind === 'return' && operation.value !== null && typedReturnValues.has(String(operation.value.value))) continue
    for (const operand of operandsOfIrOperation(operation))
      if (
        objectSurfacesOf(operand.representation).length > 0 ||
        carriesCallable(operand.representation) ||
        isDeferredCarrier(operand.representation)
      )
        promoteFull(operand.representation, `unknown-operation-boundary:${operation.kind}`)
    // An unknown iterator/await can produce an object independently from its
    // input's representation. Inventory is not a substitute for this edge.
    if ((operation.kind === 'iterator-next' || operation.kind === 'await') && operation.result !== null)
      promoteFull(operation.result.representation, `unknown-operation-result:${operation.kind}`)
  }
  currentOperation = null
  if (!options.shakeComplete) {
    for (const representation of options.representations) promoteFull(representation, 'missing-shake-facts')
    for (const representation of candidates.values()) promoteFull(representation, 'missing-shake-facts')
  }
  if (reflectionWatch !== undefined)
    for (const [key, row] of rows)
      if (key.includes(reflectionWatch)) console.error(`[REFLECTION-ROW] ${key} level=${row.level} reasons=${[...row.reasons].join(',')}`)
  const byRepresentation = new Map<string, ReflectionDemand>()
  for (const [key, row] of rows)
    byRepresentation.set(
      key,
      Object.freeze({
        level: row.level,
        ...(unrestricted.has(key) ? {} : { fieldOperations: fieldOperations.get(key) ?? new Map() }),
        reasons: new Set(row.reasons),
        representations: new Set(row.representations)
      })
    )
  const classesOut = new Map<DeclarationId, ReflectionDemand>()
  const recordsOut = new Map<StructuralTypeId, ReflectionDemand>()
  const joinFields = (left: ReflectionDemand, right: ReflectionDemand): ReflectionFieldOperations | undefined => {
    if (left.fieldOperations === undefined || right.fieldOperations === undefined) return undefined
    const fields = new Map<string, Set<ReflectionFieldOperation>>()
    for (const demand of [left, right])
      for (const [key, uses] of demand.fieldOperations!) {
        const joined = fields.get(key) ?? new Set<ReflectionFieldOperation>()
        for (const use of uses) joined.add(use)
        fields.set(key, joined)
      }
    return fields
  }
  const join = (left: ReflectionDemand | undefined, right: ReflectionDemand): ReflectionDemand =>
    left === undefined
      ? right
      : {
          level: left.level === 'full' || right.level === 'full' ? 'full' : 'keys-only',
          ...(joinFields(left, right) === undefined ? {} : { fieldOperations: joinFields(left, right)! }),
          reasons: new Set([...left.reasons, ...right.reasons]),
          representations: new Set([...left.representations, ...right.representations])
        }
  for (const representation of candidates.values()) {
    const demand = byRepresentation.get(representationKey(representation))
    if (!demand) continue
    if (representation.kind === 'class-ref')
      classesOut.set(representation.declaration, join(classesOut.get(representation.declaration), demand))
    else if (representation.kind === 'record' || representation.kind === 'record-with-index' || representation.kind === 'native-record-ref')
      recordsOut.set(representation.shapeId as StructuralTypeId, join(recordsOut.get(representation.shapeId as StructuralTypeId), demand))
  }
  const exposure: ReflectionExposure = {
    classes: classesOut,
    records: recordsOut,
    byRepresentation,
    complete: options.shakeComplete,
    ...(options.trace ? { boundaries: { origins, affecting, parents, callableReads } } : {})
  }
  return options.physicalClasses ? closePhysicalClassReflection(exposure, options.physicalClasses) : exposure
}
