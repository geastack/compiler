import type { IrValueId } from '../identity/ids.js'
import { awaitedRepresentation, nativePromiseBaseOf } from '../representation/promise-resolution.js'
import type { Representation } from '../representation/model.js'
import type { CallOperation, IrOperation } from './model.js'
import type { OperationConversionInput } from './operation-conversions.js'
import { thrownValueCarrier } from './lower-exceptions.js'

/** Host identity comes from the checker's authenticated method binding, never a C++ spelling. */
export const hostPromiseConversionInputsOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null
): readonly OperationConversionInput[] => {
  const read = definitionOf(operation.callee.value)
  if (read?.kind !== 'get') return []
  const protocol =
    read.hostMethod?.protocol ?? (read.receiver.representation.kind === 'native-handle' ? read.receiver.representation.protocol : null)
  if (protocol !== 'PromiseConstructor') return []
  const key = definitionOf(read.key.value)
  const member = read.hostMethod?.member ?? (key?.kind === 'constant' && key.literal === 'string' ? key.text : null)
  const result = operation.result?.representation
  if (result?.kind !== 'promise') return []
  const argument = operation.arguments[0]?.representation
  if (!argument) return []
  const inputs: OperationConversionInput[] = []
  const add = (source: Representation, target: Representation): void => {
    inputs.push({ role: 'host-promise-completion', source, target })
  }
  if (member === 'reject') {
    add(argument, thrownValueCarrier)
    return inputs
  }
  if (member === 'resolve') {
    if (argument.kind === 'dynamic' && result.value.kind !== 'dynamic') add(argument, result.value)
    return inputs
  }
  if (member === 'race') {
    const enter = (element: Representation): void => {
      const promise = nativePromiseBaseOf(element) ?? (element.kind === 'promise' ? element : null)
      if (promise?.value.kind === 'void' && promise.value.bottom) return
      const source = promise ? (promise.value.kind === 'void' ? { kind: 'undefined' as const } : promise.value) : element
      add(source, result.value)
    }
    if (argument.kind === 'array-object') enter(argument.element)
    else if (argument.kind === 'record' && argument.fields.every((field, position) => field.required && field.key === String(position)))
      for (const field of argument.fields) enter(field.value)
    return inputs
  }
  if (member === 'all' && argument.kind === 'array-object' && result.value.kind === 'record') {
    const settled =
      argument.element.kind === 'promise'
        ? argument.element.value
        : (nativePromiseBaseOf(argument.element)?.value ?? awaitedRepresentation(argument.element))
    if (!settled || (settled.kind === 'void' && settled.bottom)) return inputs
    const source: Representation = settled.kind === 'void' ? { kind: 'undefined' } : settled
    for (const [position, field] of result.value.fields.entries())
      if (
        field.required &&
        field.key === String(position) &&
        !(source.kind === 'undefined' && (field.value.kind === 'undefined' || field.value.kind === 'void'))
      )
        add(source, field.value)
  }
  return inputs
}
