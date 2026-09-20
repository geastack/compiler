import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation, type RecordField } from '../representation/model.js'
import type { IrOperand } from './model.js'

export interface ObjectValueConversionInput {
  readonly role: 'descriptor-value' | 'callable-property'
  readonly argument: number
  readonly field: string
  readonly source: Representation
  readonly target: Representation
}

/** Values produced inside an authenticated Object intrinsic's field walk
 * still require a conversion citation before certification and printing. */
export interface ObjectValueConversion extends ObjectValueConversionInput {
  readonly conversion: ConversionNodeId
}

export const objectValueConversionInputsOf = (
  intrinsic: string | undefined,
  args: readonly IrOperand[],
  deriver: RepresentationDeriver
): readonly ObjectValueConversionInput[] => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const fieldsOf = (value: Representation): readonly RecordField[] => {
    if (value.kind === 'optional') return fieldsOf(value.payload)
    if (value.kind === 'record' || value.kind === 'record-with-index') return value.fields
    if (value.kind === 'class-ref' || (value.kind === 'native-record-ref' && value.native === null))
      return recordFieldsOfShape(deriver, value.shapeId) ?? []
    return []
  }
  if (intrinsic === 'object-define-property') {
    const descriptor = args[2]?.representation
    const value = descriptor && fieldsOf(descriptor).find((field) => field.key === 'value')
    if (!value) return []
    const source = value.value.kind === 'optional' && value.value.absence === 'undefined' ? value.value.payload : value.value
    return source.kind === 'dynamic' ? [] : [{ role: 'descriptor-value', argument: 2, field: 'value', source, target: dynamic }]
  }
  const target = args[0]?.representation
  if (intrinsic !== 'object-assign' || !target || !isNativeCallableCarrier(target.kind)) return []
  return args.slice(1).flatMap((argument, index) =>
    fieldsOf(argument.representation).map((field) => ({
      role: 'callable-property',
      argument: index + 1,
      field: field.key,
      source: field.value,
      target: dynamic
    }))
  )
}

export const objectValueConversionsOf = (
  intrinsic: string | undefined,
  args: readonly IrOperand[],
  deriver: RepresentationDeriver,
  conversions: ConversionCensus
): readonly ObjectValueConversion[] =>
  objectValueConversionInputsOf(intrinsic, args, deriver).map((input) => ({
    ...input,
    conversion: conversions.nodeFor(input.source, input.target).id
  }))

export const objectValueConversionsMatch = (
  expected: readonly ObjectValueConversionInput[],
  actual: readonly ObjectValueConversion[],
  conversions: Pick<ConversionCensus, 'nodeById'>
): boolean =>
  expected.length === actual.length &&
  expected.every((input, index) => {
    const value = actual[index]!
    const node = conversions.nodeById(value.conversion)
    return (
      input.role === value.role &&
      input.argument === value.argument &&
      input.field === value.field &&
      representationKey(input.source) === representationKey(value.source) &&
      representationKey(input.target) === representationKey(value.target) &&
      node !== null &&
      representationKey(node.source) === representationKey(input.source) &&
      representationKey(node.target) === representationKey(input.target)
    )
  })
