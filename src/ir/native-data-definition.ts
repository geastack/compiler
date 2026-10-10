import type { ConversionNodeId } from '../conversion/algebra.js'
import { transfersNativeStorage } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeClosureOf, recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { nativeFieldViewPlansOf } from '../conversion/native-field-view.js'
import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredFieldRepresentationOf, recordShapeLayoutsOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { symbolPropertyKeyText } from '../semantics/model/structural-types.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'
import { censusConstructorViewShapes, constructorViewFieldsOf } from './class-static-fields.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperation } from './model.js'
import { nativeFieldViewBodyCitationsOf, nativeFieldViewCarrierNeedsReceipt, nativeFieldViewTargetsOf } from './native-field-view-facts.js'
import { resultOfIrOperation } from './queries.js'
import { objectValueConversionsOf } from './object-value-conversions.js'
import { intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import { descriptorOwnProtocolMatches } from './descriptor-own-protocol.js'
import { fixedDataDefinitionAttributesOf } from './fixed-data-definition-attributes.js'

export interface NativeDataDefinitionRecipe {
  readonly receiver: IrValueId
  readonly descriptor: IrValueId
  readonly key: IrValueId
  readonly keyText: string
  readonly source: Representation
  readonly held: Representation
  readonly conversion: ConversionNodeId
  readonly delegatesView: boolean
  /** The certified Value boundary a `dynamic` arm or a view's original
   * Document observes the native payload through; absent when every holder is
   * a typed field. */
  readonly materialization?: ConversionNodeId
  readonly destinations: readonly { readonly carrier: string; readonly shape: string; readonly field: RecordField }[]
}

export interface NativeDataDefinitionInput {
  readonly graph: SemanticGraph
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly deriver: RepresentationDeriver
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly conversions: ConversionCensus
  readonly calleeRendering: CalleeRenderingInput | undefined
}

/** A typed descriptor is consumed by actual native data fields, not an unknown property observation. */
export const nativeDataDefinitionOf = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  input: NativeDataDefinitionInput,
  definitionOf: (value: IrValueId) => IrOperation | null
): NativeDataDefinitionRecipe | null => {
  if (
    semantic?.family !== 'invocation' ||
    semantic.intrinsicMutation !== 'object-define-property' ||
    operation.argumentsAreSpread ||
    operation.arguments.length !== 3 ||
    !authenticatedTemplateCallEntry(operation, semantic, input.calleeRendering, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 2, definitionOf)
  )
    return null
  const [receiver, key, descriptor] = operation.arguments
  if (!receiver || !key || !descriptor || descriptor.representation.kind !== 'record' || descriptor.representation.accessors.length)
    return null
  const keySource = definitionOf(key.value)
  const semanticKey = semantic.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 1)
  const literalKey =
    keySource?.kind === 'constant' &&
    keySource.literal === 'string' &&
    semanticKey?.source.kind === 'constant' &&
    semanticKey.source.literal === 'string' &&
    semanticKey.source.text === keySource.text
      ? keySource.text
      : null
  // A `unique symbol` key (`Object.defineProperty(decrypted, kDecoratedKeys,
  // ...)`) is as static as a literal: its type pins the one declaration, whose
  // `sym(<declaration>)` marker names the layout's own symbol member.
  const symbolShape =
    literalKey === null && key.representation.kind === 'symbol' && semanticKey !== undefined
      ? input.graph.structuralTypes.get(semanticKey.type)?.shape
      : undefined
  const keyText = literalKey ?? (symbolShape?.kind === 'unique-symbol' ? symbolPropertyKeyText(symbolShape.declaration) : null)
  if (keyText === null) return null
  const value = descriptor.representation.fields.find((field) => field.key === 'value')
  if (
    !value?.required ||
    !descriptorOwnProtocolMatches(
      operation,
      semantic,
      input.graph,
      definitionOf,
      descriptor.representation.fields.map((field) => field.key)
    ) ||
    value.value.kind === 'dynamic' ||
    descriptor.representation.fields.some(
      (field) =>
        field.key !== 'value' &&
        (!['writable', 'enumerable', 'configurable'].includes(field.key) ||
          !field.required ||
          field.value.kind !== 'scalar' ||
          field.value.domain !== 'boolean')
    )
  )
    return null
  const shapes = censusConstructorViewShapes([...input.bodies.values()])
  const liveTargets = nativeFieldViewTargetsOf(input.bodies.values(), input.conversions)
  const delegatesView = nativeFieldViewCarrierNeedsReceipt(receiver.representation, liveTargets)
  if (operation.fixedDataDefinition && !delegatesView) return null
  // Only a live view needs the symbol member's delegation receipt; a plain
  // receiver keeps its ordinary descriptor path.
  if (literalKey === null && !delegatesView) return null
  const nodes = [...input.bodies.values()]
    .flatMap((body) => nativeFieldViewBodyCitationsOf(body))
    .flatMap((id) => {
      const node = input.conversions.nodeById(id)
      return node === null ? [] : [node]
    })
  const origins = nativeFieldViewPlansOf(recipeClosureOf(nodes, input.conversions.nodeById).values())
  const layouts = recordShapeLayoutsOf(input.deriver, input.classes)
  const destinations: Array<{ carrier: string; shape: string; field: RecordField }> = []
  let held: Representation | null = null
  let observedDynamically = false
  const visit = (carrier: Representation, ancestors: ReadonlySet<string> = new Set()): boolean => {
    if (carrier.kind === 'tagged-union') return carrier.arms.every((arm) => visit(arm.value, ancestors))
    // A union's `dynamic` arm defines through its own Value's
    // [[DefineOwnProperty]]; a live view's original Document receives the
    // view's delegated definition under the same PropertyKey. Both hold the
    // native payload the typed arm's field declares, so neither names a field.
    if (
      (carrier.kind === 'dynamic' && ancestors.size === 0) ||
      (carrier.kind === 'dictionary' && carrier.ownership === 'shared-refcount' && ancestors.size > 0)
    ) {
      observedDynamically = true
      return true
    }
    const identity = representationKey(carrier)
    if (ancestors.has(identity)) return false
    let shape: string
    let field: RecordField | undefined
    let storage: Representation | null
    if (carrier.kind === 'constructor-family' || carrier.kind === 'constructor-identity') {
      if (carrier.kind === 'constructor-family' && carrier.members.some((member) => member.includes('@'))) return false
      const views = constructorViewFieldsOf(shapes, input.deriver, keyText)
      if (views.length !== 1) return false
      shape = views[0]!.shape
      field = views[0]!.field
      storage = field.value
    } else if (
      carrier.kind === 'record' ||
      carrier.kind === 'record-with-index' ||
      carrier.kind === 'class-ref' ||
      (carrier.kind === 'native-record-ref' && carrier.native === null)
    ) {
      if (carrier.ownership !== 'shared-refcount') return false
      shape = carrier.shapeId
      if (layouts.accessorsForShape?.(shape)?.some((accessor) => accessor.key === keyText)) return false
      field = (carrier.kind === 'record' || carrier.kind === 'record-with-index' ? carrier.fields : layouts.forShape(shape))?.find(
        (field) => field.key === keyText
      )
      storage = declaredFieldRepresentationOf(input.deriver, carrier, keyText, input.classes)
    } else return false
    if (!field || !storage || (held && representationKey(held) !== representationKey(storage))) return false
    held = storage
    if (!destinations.some((destination) => destination.carrier === identity)) destinations.push({ carrier: identity, shape, field })
    if (nativeFieldViewCarrierNeedsReceipt(carrier, liveTargets)) {
      const sources = origins.filter((origin) => origin.target.shapeId === shape)
      if (!sources.length || !sources.every((origin) => visit(origin.source, new Set([...ancestors, identity])))) return false
    }
    return true
  }
  if (!visit(receiver.representation) || held === null || destinations.length === 0) return null
  const conversion = input.conversions.nodeFor(value.value, held)
  if (
    !transfersNativeStorage(conversion.capability) ||
    !recipeIsMaterializableWithoutPriorSourceGuard(conversion, input.conversions.nodeById)
  )
    return null
  const materialization = observedDynamically
    ? input.conversions.nodeFor(held, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
    : null
  if (materialization !== null && !recipeIsMaterializableWithoutPriorSourceGuard(materialization, input.conversions.nodeById)) return null
  return {
    receiver: receiver.value,
    descriptor: descriptor.value,
    key: key.value,
    keyText,
    source: value.value,
    held,
    conversion: conversion.id,
    delegatesView,
    ...(materialization === null ? {} : { materialization: materialization.id }),
    destinations
  }
}

export const nativeDataDefinitionMatches = (expected: NativeDataDefinitionRecipe | null, actual: NativeDataDefinitionRecipe): boolean =>
  expected !== null &&
  expected.receiver === actual.receiver &&
  expected.descriptor === actual.descriptor &&
  expected.key === actual.key &&
  expected.keyText === actual.keyText &&
  expected.conversion === actual.conversion &&
  expected.delegatesView === actual.delegatesView &&
  expected.materialization === actual.materialization &&
  representationKey(expected.source) === representationKey(actual.source) &&
  representationKey(expected.held) === representationKey(actual.held) &&
  expected.destinations.length === actual.destinations.length &&
  expected.destinations.every((field, index) => {
    const other = actual.destinations[index]!
    return (
      field.carrier === other.carrier &&
      field.shape === other.shape &&
      field.field.key === other.field.key &&
      field.field.required === other.field.required &&
      representationKey(field.field.value) === representationKey(other.field.value)
    )
  })

export const publishNativeDataDefinitions = (
  input: NativeDataDefinitionInput & { readonly graph: SemanticGraph }
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const attributes = fixedDataDefinitionAttributesOf(input)
  return new Map(
    [...input.bodies].map(([id, body]) => {
      const definitions = new Map<IrValueId, IrOperation>()
      for (const block of body.blocks.values())
        for (const operation of allOperationsOf(block)) {
          const result = resultOfIrOperation(operation)
          if (result) definitions.set(result.id, operation)
        }
      const publish = (operation: IrOperation): IrOperation => {
        if (operation.kind !== 'call') return operation
        const semanticId = input.graph.results.get(operation.lineage)
        const semantic = semanticId === undefined ? null : (input.graph.operations.get(semanticId) ?? null)
        const { nativeDataDefinition: previous, ...original } = operation
        const attributeRecipe = attributes.get(operation)
        const ordinary: CallOperation = attributeRecipe
          ? { ...original, fixedDataDefinition: attributeRecipe }
          : original.fixedDataDefinition?.attributesOnly !== undefined
            ? (({ fixedDataDefinition: _stale, ...rest }) => rest)(original)
            : original
        const recipe = nativeDataDefinitionOf(ordinary, semantic, input, (value) => definitions.get(value) ?? null)
        if (recipe === null)
          return previous === undefined
            ? ordinary
            : {
                ...ordinary,
                objectValueConversions: objectValueConversionsOf(
                  semantic?.family === 'invocation' ? semantic.intrinsicMutation : undefined,
                  ordinary.arguments,
                  input.deriver,
                  input.conversions
                )
              }
        const { fixedDataDefinition: fixed, ...delegated } = ordinary
        return {
          ...(recipe.delegatesView ? delegated : ordinary),
          nativeDataDefinition: recipe,
          objectValueConversions: (operation.objectValueConversions ?? []).filter(
            (value) => value.role !== 'descriptor-value' || value.argument !== 2 || value.field !== 'value'
          )
        }
      }
      return [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              { ...block, operations: block.operations.map((operation) => publish(operation) as typeof operation) }
            ])
          )
        }
      ]
    })
  )
}
