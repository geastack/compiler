import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredFieldRepresentationOf, recordFieldsOfShape, nativeBaseFieldOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import type { IrOperand } from './model.js'

/** The descriptor's value and attribute reads are native fixed slots, not an unknown function invocation. */
export interface FixedDataDefinitionRecipe {
  readonly nativeFieldProtocol: 'unused' | 'required'
  readonly target: string
  readonly descriptor: string
  readonly field: RecordField
  readonly held: Representation
  readonly value: RecordField
  readonly conversion: ConversionNodeId
  readonly attributes: readonly RecordField[]
}

export const fixedDataDefinitionRecipeOf = (
  args: readonly IrOperand[],
  key: string,
  result: Representation,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  authenticated: boolean
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
  if (!value?.required) return null
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
