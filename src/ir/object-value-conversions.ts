import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { isNativeError } from '../representation/prototype-domains.js'
import { recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation, type RecordField } from '../representation/model.js'
import type { IrOperand } from './model.js'

export interface ObjectValueConversionInput {
  readonly role: 'descriptor-value' | 'callable-property' | 'error-property'
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
    const fields = descriptor ? fieldsOf(descriptor) : []
    const value = fields.find((field) => field.key === 'value')
    const source = value && (value.value.kind === 'optional' && value.value.absence === 'undefined' ? value.value.payload : value.value)
    // An object LITERAL's `get`/`set` is the program's own function, handed
    // over as ECMA-262 stores an accessor half: a function object the
    // descriptor calls with the property's receiver. That is the same boxed
    // callable `value` becomes for a data property, and it keeps the
    // function's own receiver convention (`Value::callWithReceiver`). A
    // descriptor RECORD read back off `getOwnPropertyDescriptor` carries its
    // halves `optional` and receiver-less, and is not cited: re-installing one
    // of those would lose the `this` the original accessor was called with.
    const halves = fields.filter(
      (field) => (field.key === 'get' || field.key === 'set') && field.required && field.value.kind !== 'optional'
    )
    return [
      ...(source === undefined || source.kind === 'dynamic'
        ? []
        : [{ role: 'descriptor-value' as const, argument: 2, field: 'value', source, target: dynamic }]),
      ...halves
        .filter((field) => field.value.kind !== 'dynamic')
        .map((field) => ({ role: 'descriptor-value' as const, argument: 2, field: field.key, source: field.value, target: dynamic }))
    ]
  }
  const target = args[0]?.representation
  if (intrinsic !== 'object-assign' || !target) return []
  const role = isNativeCallableCarrier(target.kind) ? 'callable-property' : isNativeError(target) ? 'error-property' : null
  if (role === null) return []
  return args.slice(1).flatMap((argument, index) =>
    fieldsOf(argument.representation).map((field) => ({
      role,
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
