import type { FunctionId, IrValueId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { recordAccessorsOfShape, recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { holdsThenable } from '../representation/promise-resolution.js'
import type { IrBody, IrOperation } from './model.js'
import type { OperationConversionInput } from './operation-conversions.js'
import { thrownValueCarrier } from './lower-exceptions.js'

const undefinedValue: Representation = { kind: 'undefined' }
const booleanValue: Representation = { kind: 'scalar', domain: 'boolean' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const dynamicResult: Representation = { kind: 'dynamic', reason: 'opt-in-fallback' }

/** Values produced by the operation's native primitive must enter its declared result explicitly. */
export const internalOperationConversionInputsOf = (
  operation: IrOperation,
  deriver: RepresentationDeriver,
  abis?: ReadonlyMap<FunctionId, CallableAbi>,
  body?: IrBody,
  definitionOf?: (value: IrValueId) => IrOperation | null
): readonly OperationConversionInput[] => {
  const inputs = new Map<string, OperationConversionInput>()
  const add = (role: OperationConversionInput['role'], source: Representation, target: Representation): void => {
    if (representationKey(source) !== representationKey(target))
      inputs.set(`${role}:${representationKey(source)}->${representationKey(target)}`, { role, source, target })
  }
  const awaitValue = (source: Representation, target: Representation): void => {
    if (target.kind === 'void') return
    if (source.kind === 'optional' && holdsThenable(source.payload)) {
      awaitValue(source.payload, target)
      add('await-result', { kind: source.absence }, target)
    } else if (source.kind === 'tagged-union' && holdsThenable(source)) {
      for (const arm of source.arms) awaitValue(arm.value, target)
    } else if (source.kind === 'promise') add('await-result', source.value.kind === 'void' ? undefinedValue : source.value, target)
    else if (source.kind === 'class-ref' && source.nativeBase?.kind === 'promise')
      add('await-result', source.nativeBase.value.kind === 'void' ? undefinedValue : source.nativeBase.value, target)
    else add('await-result', source, target)
  }
  const fields = (value: Representation) =>
    value.kind === 'record'
      ? value.fields
      : value.kind === 'native-record-ref' && value.native === null
        ? recordFieldsOfShape(deriver, value.shapeId)
        : null
  const accessors = (value: Representation) =>
    value.kind === 'record'
      ? value.accessors
      : value.kind === 'native-record-ref' && value.native === null
        ? recordAccessorsOfShape(deriver, value.shapeId)
        : null
  const member = (value: Representation, key: string): Representation | null => {
    const field = fields(value)?.find((field) => field.key === key)
    if (field) return field.value
    const getter = accessors(value)?.find((accessor) => accessor.key === key)?.getter
    if (!getter) return null
    const abi = abis?.get(getter)
    if (abi?.receiver) add('iterator-value', value, abi.receiver)
    return abi?.result ?? null
  }
  if (operation.kind === 'allocate-array-object' && operation.result.representation.kind === 'array-object') {
    const target = operation.result.representation.element
    for (const slot of operation.elements) {
      if (slot.kind === 'element') add('array-element', slot.value.representation, target)
      else if (slot.kind === 'spread' && slot.element !== undefined) {
        const source = slot.value.representation
        if (source.kind === 'array-object') add('array-element', source.element, target)
        else if (source.kind === 'keyed-collection' && source.family === 'set') add('array-element', source.key, target)
      }
    }
  }
  if (operation.kind === 'await' && operation.result) awaitValue(operation.operand.representation, operation.result.representation)
  if (operation.kind === 'yield') {
    const cursor = body?.abi?.result
    if (cursor?.kind === 'iterator' || cursor?.kind === 'async-generator') {
      add('yield-value', operation.operand?.representation ?? undefinedValue, cursor.element)
      if (operation.result && cursor.resume.kind !== 'void' && cursor.resume.kind !== 'undefined')
        add('yield-value', cursor.resume, operation.result.representation)
    }
  }
  if (operation.kind === 'get-iterator') {
    const method = operation.method && abiOfCallee(operation.method.representation)
    if (method?.receiver) add('iterator-value', operation.receiver.representation, method.receiver)
    const source = operation.receiver.representation
    const target = operation.result.representation
    if (!operation.method && operation.protocol !== 'enumerate' && source.kind === 'tagged-union' && target.kind === 'iterator')
      for (const arm of source.arms) {
        if (arm.value.kind === 'array-object') add('iterator-value', arm.value.element, target.element)
        else if (arm.value.kind === 'keyed-collection' && arm.value.family === 'set') add('iterator-value', arm.value.key, target.element)
      }
  }
  if (operation.kind === 'iterator-next') {
    const source = operation.iterator.representation
    const target = operation.result.representation
    if (source.kind === 'dynamic') {
      if (target.kind !== 'dynamic') {
        add('iterator-value', undefinedValue, target)
        add('iterator-value', dynamic, target)
      }
    } else if (source.kind === 'async-generator') add('iterator-value', source.element, target)
    else if (source.kind === 'iterator') {
      if (operation.settlesValue) awaitValue(source.element, target)
      else if (representationKey(source.element) !== representationKey(target)) {
        add('iterator-value', undefinedValue, target)
        add('iterator-value', source.element, target)
      }
    } else {
      const next = member(source, 'next')
      const abi = next && abiOfCallee(next)
      if (abi?.receiver) add('iterator-value', source, abi.receiver)
      const result = abi?.result.kind === 'promise' ? abi.result.value : abi?.result
      if (result?.kind === 'tagged-union')
        for (const arm of result.arms) {
          const value = member(arm.value, 'value')
          const done = member(arm.value, 'done')
          if (value) add('iterator-value', value, target)
          if (done) add('iterator-value', done, booleanValue)
        }
    }
  }
  if (operation.kind === 'call' && definitionOf) {
    const read = definitionOf(operation.callee.value)
    const key = read?.kind === 'get' ? definitionOf(read.key.value) : null
    if (read?.kind === 'get' && key?.kind === 'constant' && key.literal === 'string' && ['next', 'return', 'throw'].includes(key.text)) {
      const cursors = (source: Representation): readonly Extract<Representation, { kind: 'iterator' | 'async-generator' }>[] =>
        source.kind === 'optional'
          ? cursors(source.payload)
          : source.kind === 'tagged-union'
            ? source.arms.flatMap((arm) => cursors(arm.value))
            : source.kind === 'iterator' || source.kind === 'async-generator'
              ? [source]
              : []
      for (const cursor of cursors(read.receiver.representation)) {
        const argument = operation.arguments[0]
        const allocation = argument && definitionOf(argument.value)
        const sendsNothing =
          !argument ||
          argument.representation.kind === 'undefined' ||
          argument.representation.kind === 'void' ||
          (allocation?.kind === 'allocate-array-object' && allocation.elements.length === 0)
        if (key.text === 'throw' && argument) add('iterator-value', argument.representation, thrownValueCarrier)
        else if (!sendsNothing && argument) {
          const channel = key.text === 'next' ? cursor.resume : cursor.completion
          if (channel.kind !== 'void' && channel.kind !== 'undefined') add('iterator-value', argument.representation, channel)
        }
        const result = operation.result?.representation
        const step = result?.kind === 'promise' ? result.value : result
        if (step?.kind === 'tagged-union')
          for (const arm of step.arms) {
            const shape = fields(arm.value)
            const done = shape?.find((field) => field.key === 'done')
            const value = shape?.find((field) => field.key === 'value')
            if (done) add('iterator-value', booleanValue, done.value)
            if (done && value && value.value.kind !== 'void' && value.value.kind !== 'undefined') {
              const source = done.required ? cursor.completion : cursor.element
              add('iterator-value', source.kind === 'void' ? undefinedValue : source, value.value)
            }
          }
      }
    }
  }
  if (operation.kind === 'compute') {
    const [first, second] = operation.operands
    const target = operation.result.representation
    if (first && second && operation.operator === '+' && target.kind !== 'string') {
      const oneDynamic = (first.representation.kind === 'dynamic') !== (second.representation.kind === 'dynamic')
      const anyDynamic = operation.operands.some(
        (operand) => operand.representation.kind === 'dynamic' || operand.representation.kind === 'tagged-union'
      )
      if (oneDynamic || (deriver.dynamicFallback && anyDynamic)) add('compute-result', dynamicResult, target)
    }
    if (first && second && ['===', '!==', '==', '!='].includes(operation.operator)) {
      if (first.representation.kind === 'callable-identity') add('compute-result', second.representation, first.representation)
      else if (second.representation.kind === 'callable-identity') add('compute-result', first.representation, second.representation)
    }
    if (operation.form === 'binary' && first && target.kind !== 'scalar' && target.kind !== 'string') {
      const relational = ['<', '<=', '>', '>='].includes(operation.operator)
      if (!operation.operands.some((operand) => operand.representation.kind === 'dynamic'))
        add(
          'compute-result',
          relational ? booleanValue : first.representation.kind === 'string' ? { kind: 'string' } : { kind: 'scalar', domain: 'number' },
          target
        )
    }
  }
  return [...inputs.values()]
}
