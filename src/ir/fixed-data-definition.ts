import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredFieldRepresentationOf, recordFieldsOfShape, nativeBaseFieldOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { CallOperation, IrOperand, IrOperation } from './model.js'

/** The descriptor's value and attribute reads are native fixed slots, not an unknown function invocation. */
export interface FixedDataDefinitionRecipe {
  readonly nativeFieldProtocol: 'unused' | 'required'
  readonly target: string
  readonly descriptor: string
  readonly field: RecordField
  readonly held: Representation
  readonly value: RecordField | null
  readonly conversion: ConversionNodeId | null
  /** Attribute-only definitions retain current storage. Creation, if admitted,
   * uses the separately cited Undefined child rather than reading that storage. */
  readonly attributesOnly?: {
    readonly receiver: IrValueId
    readonly descriptor: IrValueId
    readonly key: IrValueId
    readonly allocation: IrValueId
    readonly initialized: IrValueId | null
    readonly absence: ConversionNodeId | null
  }
  readonly attributes: readonly RecordField[]
}

/** The physical destination makes this a native field boundary even when
 * optional discovery failed to publish its recipe.
 * @semanticCategory generic-primitive
 */
export const fixedDataDefinitionUsesNativeField = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  definitionOf: (value: IrValueId) => IrOperation | null
): boolean => {
  const target = operation.arguments[0]?.representation
  const key = operation.arguments[1]
  const actual = key && definitionOf(key.value)
  return (
    semantic?.family === 'invocation' &&
    semantic.intrinsicMutation === 'object-define-property' &&
    target !== undefined &&
    ['record', 'record-with-index', 'class-ref', 'native-record-ref'].includes(target.kind) &&
    actual?.kind === 'constant' &&
    actual.literal === 'string' &&
    declaredFieldRepresentationOf(deriver, target, actual.text, classes) !== null &&
    nativeBaseFieldOf(deriver, target, actual.text, classes) === null
  )
}

export const fixedDataDefinitionRecipeOf = (
  args: readonly IrOperand[],
  key: string,
  result: Representation,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  authenticated: boolean,
  attributesOnly?: FixedDataDefinitionRecipe['attributesOnly']
): FixedDataDefinitionRecipe | null => {
  const target = args[0]?.representation
  const descriptor = args[2]?.representation
  if (!target || args.length !== 3 || descriptor?.kind !== 'record' || descriptor.accessors.length > 0) return null
  if (representationKey(result) !== representationKey(target)) return null
  const fields =
    target.kind === 'record' || target.kind === 'record-with-index'
      ? target.fields
      : target.kind === 'class-ref' || (target.kind === 'native-record-ref' && target.native === null)
        ? recordFieldsOfShape(deriver, target.shapeId)
        : null
  const field = fields?.find((candidate) => candidate.key === key)
  if (!field || nativeBaseFieldOf(deriver, target, key, classes)) return null
  const value = descriptor.fields.find((candidate) => candidate.key === 'value')
  if (value === undefined ? attributesOnly === undefined : !value.required) return null
  const attributes = descriptor.fields.filter((candidate) => candidate.key !== 'value')
  if (
    attributes.some(
      (attribute) =>
        !['writable', 'enumerable', 'configurable'].includes(attribute.key) ||
        !attribute.required ||
        attribute.value.kind !== 'scalar' ||
        attribute.value.domain !== 'boolean'
    )
  )
    return null
  const held = declaredFieldRepresentationOf(deriver, target, key, classes)
  if (!held) return null
  if (value === undefined)
    return {
      nativeFieldProtocol: authenticated ? 'unused' : 'required',
      target: representationKey(target),
      descriptor: representationKey(descriptor),
      field,
      held,
      value: null,
      conversion: null,
      attributes,
      attributesOnly: attributesOnly!
    }
  const conversion = conversions.nodeFor(value.value, held)
  // Dynamic adapters can publish the stored object's native protocol. They
  // cannot support the closed effect claimed by this recipe.
  if (conversion.capability.kind === 'never') return null
  const closed =
    authenticated &&
    (conversion.capability.kind === 'identity' ||
      ((conversion.capability.kind === 'atom' || conversion.capability.kind === 'static') &&
        conversion.capability.materializer.nativeFieldProtocol === 'unused'))
  return {
    nativeFieldProtocol: closed ? 'unused' : 'required',
    target: representationKey(target),
    descriptor: representationKey(descriptor),
    field,
    held,
    value,
    conversion: conversion.id,
    attributes
  }
}

/** Authenticate the actual mutation inputs; an ignored Object.defineProperty return is not another target operand. */
export const fixedDataDefinitionCallMatches = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  definitionOf: (value: IrValueId) => IrOperation | null,
  attributesRecipe?: FixedDataDefinitionRecipe
): boolean => {
  const recipe = operation.fixedDataDefinition
  const target = operation.arguments[0]
  const key = semantic?.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 1)
  const keyValue = operation.arguments[1]
  const actualKey = keyValue === undefined ? null : definitionOf(keyValue.value)
  if (
    recipe === undefined ||
    target === undefined ||
    operation.argumentsAreSpread ||
    semantic?.family !== 'invocation' ||
    semantic.intrinsicMutation !== 'object-define-property' ||
    key?.source.kind !== 'constant' ||
    key.source.literal !== 'string' ||
    actualKey?.kind !== 'constant' ||
    actualKey.literal !== 'string' ||
    actualKey.text !== key.source.text
  )
    return false
  if (
    recipe.attributesOnly !== undefined &&
    (recipe.attributesOnly.receiver !== target.value ||
      recipe.attributesOnly.key !== keyValue?.value ||
      recipe.attributesOnly.descriptor !== operation.arguments[2]?.value ||
      recipe.target !== representationKey(target.representation) ||
      recipe.descriptor !== representationKey(operation.arguments[2]!.representation))
  )
    return false
  const expected =
    recipe.attributesOnly === undefined
      ? fixedDataDefinitionRecipeOf(
          operation.arguments,
          key.source.text,
          operation.result?.representation ?? target.representation,
          deriver,
          classes,
          conversions,
          semantic.intrinsicDataDefinition === true
        )
      : (attributesRecipe ?? null)
  const fieldMatches = (left: RecordField, right: RecordField): boolean =>
    left.key === right.key && left.required === right.required && representationKey(left.value) === representationKey(right.value)
  return (
    expected !== null &&
    recipe.nativeFieldProtocol === expected.nativeFieldProtocol &&
    recipe.target === expected.target &&
    recipe.descriptor === expected.descriptor &&
    fieldMatches(recipe.field, expected.field) &&
    representationKey(recipe.held) === representationKey(expected.held) &&
    (recipe.value === null ? expected.value === null : expected.value !== null && fieldMatches(recipe.value, expected.value)) &&
    recipe.conversion === expected.conversion &&
    (recipe.attributesOnly === undefined
      ? expected.attributesOnly === undefined
      : expected.attributesOnly !== undefined &&
        recipe.attributesOnly.receiver === expected.attributesOnly.receiver &&
        recipe.attributesOnly.descriptor === expected.attributesOnly.descriptor &&
        recipe.attributesOnly.key === expected.attributesOnly.key &&
        recipe.attributesOnly.allocation === expected.attributesOnly.allocation &&
        recipe.attributesOnly.initialized === expected.attributesOnly.initialized &&
        recipe.attributesOnly.absence === expected.attributesOnly.absence) &&
    recipe.attributes.length === expected.attributes.length &&
    recipe.attributes.every((attribute, index) => fieldMatches(attribute, expected.attributes[index]!))
  )
}
