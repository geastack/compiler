import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf } from '../projection/fields.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { thrownValueCarrier } from './lower-exceptions.js'
import type { CallOperation, IrOperation } from './model.js'
import type { OperationConversionInput } from './operation-conversions.js'

const undefinedValue: Representation = { kind: 'undefined' }

const promiseReceiversOf = (
  value: Representation,
  member: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): readonly Extract<Representation, { kind: 'promise' }>[] => {
  if (value.kind === 'promise') return [value]
  if (value.kind === 'optional') return promiseReceiversOf(value.payload, member, classes)
  if (value.kind === 'tagged-union') return value.arms.flatMap((arm) => promiseReceiversOf(arm.value, member, classes))
  if (value.kind === 'class-ref' && value.nativeBase?.kind === 'promise' && classMemberOf(classes, value.declaration, member) === null)
    return [value.nativeBase]
  return []
}

/** Native reaction completion and callback frames, resolved from the callee's actual property read. */
export const promiseReactionConversionInputsOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): readonly OperationConversionInput[] => {
  const read = definitionOf(operation.callee.value)
  if (read?.kind !== 'get' || read.hostMethod !== undefined) return []
  const key = definitionOf(read.key.value)
  if (key?.kind !== 'constant' || key.literal !== 'string') return []
  const member = key.text
  if (member !== 'then' && member !== 'catch' && member !== 'finally') return []
  const inputs: OperationConversionInput[] = []
  const add = (source: Representation, target: Representation): void => {
    inputs.push({ role: 'promise-reaction', source, target })
  }
  const absent = (value: Representation | undefined): boolean => value?.kind === 'undefined' || value?.kind === 'null'
  const fulfilled = member === 'then' && !absent(operation.arguments[0]?.representation) ? operation.arguments[0] : undefined
  const rejected = member === 'catch' ? operation.arguments[0] : operation.arguments[1]
  const rejectedAbi = absent(rejected?.representation) ? null : rejected ? abiOfCallee(rejected.representation) : null
  const fulfilledAbi = fulfilled ? abiOfCallee(fulfilled.representation) : null
  const published = operation.result?.representation
  const target = published?.kind === 'promise' ? published : null
  const callbackArguments = (abi: CallableAbi, source: Representation): void => {
    const first = abi.parameters[0]
    if (first) add(source, first.value)
    for (const parameter of abi.parameters.slice(1)) add(undefinedValue, parameter.value)
  }
  const settleHandler = (abi: CallableAbi): void => {
    if (!target) return
    const handled = abi.result
    if (handled.kind === 'void') {
      if (target.value.kind !== 'void') add(undefinedValue, target.value)
    } else if (handled.kind === 'optional' && handled.payload.kind === 'promise') {
      add(handled.payload, target)
      if (target.value.kind !== 'void') add(undefinedValue, target.value)
    } else if (target.value.kind === 'void' && handled.kind !== 'promise') {
      return
    } else add(handled, handled.kind === 'promise' ? target : target.value)
  }
  for (const receiver of promiseReceiversOf(read.receiver.representation, member, classes)) {
    if (member === 'finally') {
      if (target && target.value.kind !== 'void' && receiver.value.kind !== 'void') add(receiver.value, target.value)
      continue
    }
    if (member === 'then' && rejectedAbi === null && fulfilledAbi !== null) {
      if (
        receiver.value.kind !== 'void' &&
        fulfilledAbi.parameters.length === 1 &&
        fulfilledAbi.receiver === null &&
        fulfilledAbi.restFrom === null
      )
        add(receiver.value, fulfilledAbi.parameters[0]!.value)
      if (published && fulfilledAbi.result.kind !== 'tagged-union')
        add({ kind: 'promise', value: fulfilledAbi.result.kind === 'promise' ? fulfilledAbi.result.value : fulfilledAbi.result }, published)
      continue
    }
    if (rejectedAbi === null) continue
    callbackArguments(rejectedAbi, thrownValueCarrier)
    settleHandler(rejectedAbi)
    if (fulfilledAbi) {
      callbackArguments(fulfilledAbi, receiver.value.kind === 'void' ? undefinedValue : receiver.value)
      settleHandler(fulfilledAbi)
    } else if (target && receiver.value.kind !== 'void') add(receiver.value, target.value)
  }
  return inputs
}
