import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredRecordFieldOf, recordFieldsOfShape, recordIndexesOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { ownershipOf, recordIndexForKeyCarrier, representationKey, type RecordField, type Representation } from '../representation/model.js'
import type { IrOperation } from './model.js'

export type OperationConversionRole = 'field-read' | 'index-read' | 'dynamic-write' | 'descriptor' | 'update' | 'equality' | 'object-sidecar'

/** A value produced inside an operation, rather than supplied as an operand. */
export interface OperationConversionInput {
  readonly role: OperationConversionRole
  readonly source: Representation
  readonly target: Representation
}

export interface OperationConversion extends OperationConversionInput {
  readonly conversion: ConversionNodeId
}

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

const leavesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? [...leavesOf(value.payload), { kind: value.absence }]
    : value.kind === 'tagged-union'
      ? value.arms.flatMap((arm) => leavesOf(arm.value))
      : [value]

const fieldsOf = (value: Representation, deriver: RepresentationDeriver): readonly RecordField[] => {
  if (value.kind === 'record' || value.kind === 'record-with-index') return value.fields
  if (value.kind === 'class-ref' || (value.kind === 'native-record-ref' && value.native === null))
    return recordFieldsOfShape(deriver, value.shapeId) ?? []
  return []
}

const indexedValueOf = (
  value: Representation,
  key: Representation,
  keyText: string | null,
  deriver: RepresentationDeriver
): Representation | null => {
  const indexes =
    value.kind === 'record-with-index'
      ? value.indexes
      : value.kind === 'native-record-ref' && value.native === null
        ? recordIndexesOfShape(deriver, value.shapeId)
        : []
  return recordIndexForKeyCarrier(indexes, key, keyText ?? undefined)?.value ?? null
}

const carriesSidecar = (value: Representation): boolean =>
  ownershipOf(value) === 'shared-refcount' &&
  (value.kind === 'class-ref' || value.kind === 'record' || value.kind === 'record-with-index' || value.kind === 'native-record-ref')

const callableIdentityComparison = (value: Representation): boolean =>
  isNativeCallableCarrier(value.kind) || value.kind === 'callable-identity'

/**
 * Publish the internal value adaptations an operation actually requires.
 * The pair comes from native storage and the operation's published result;
 * conversion admission remains the census's decision.
 */
export const operationConversionInputsOf = (
  operation: IrOperation,
  keyText: string | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): readonly OperationConversionInput[] => {
  const inputs = new Map<string, OperationConversionInput>()
  const add = (role: OperationConversionRole, source: Representation, target: Representation): void => {
    if (representationKey(source) === representationKey(target)) return
    inputs.set(`${role}:${representationKey(source)}->${representationKey(target)}`, { role, source, target })
  }
  if (operation.kind === 'compute') {
    if (operation.form === 'update') {
      const value = operation.operands[0]
      if (value) add('update', value.representation, operation.result.representation)
    }
    if ((operation.operator === '===' || operation.operator === '!==') && !operation.nativeEquality) {
      const left = operation.operands[0]
      const right = operation.operands[1]
      if (left && right) {
        for (const first of leavesOf(left.representation))
          for (const second of leavesOf(right.representation)) {
            if (first.kind === 'dynamic' && second.kind !== 'dynamic' && !callableIdentityComparison(second))
              add('equality', second, first)
            if (second.kind === 'dynamic' && first.kind !== 'dynamic' && !callableIdentityComparison(first))
              add('equality', first, second)
          }
      }
    }
  }
  if (operation.kind === 'get') {
    const result = operation.result.representation
    const present = result.kind === 'optional' ? result.payload : result
    for (const receiver of leavesOf(operation.receiver.representation)) {
      if (keyText !== null) {
        const field = declaredRecordFieldOf(deriver, receiver, keyText, classes)
        if (field) add('field-read', field.value, result)
      }
      if (receiver.kind === 'dictionary') add('index-read', receiver.value, present)
      if (receiver.kind === 'array-object' && (keyText === null || /^(0|[1-9][0-9]*)$/.test(keyText)))
        add('index-read', receiver.element, present)
      if (keyText === null || declaredRecordFieldOf(deriver, receiver, keyText, classes) === null)
        {
          const indexed = indexedValueOf(receiver, operation.key.representation, keyText, deriver)
          if (indexed) add('index-read', indexed, present)
        }
    }
  }
  if (operation.kind === 'set' || operation.kind === 'define-own-property') {
    for (const receiver of leavesOf(operation.receiver.representation)) {
      const declared = keyText === null ? null : declaredRecordFieldOf(deriver, receiver, keyText, classes)
      const indexed = indexedValueOf(receiver, operation.key.representation, keyText, deriver)
      if (receiver.kind === 'dynamic' || receiver.kind === 'native-handle' || (carriesSidecar(receiver) && !declared && !indexed))
        add('dynamic-write', operation.value.representation, dynamic)
      if (operation.kind === 'define-own-property' && !declared && indexed) add('descriptor', indexed, dynamic)
    }
  }
  if (operation.kind === 'allocate-record' && operation.result.representation.kind === 'dynamic')
    for (const field of operation.fields) add('dynamic-write', field.value.representation, dynamic)
  if (operation.kind === 'allocate-array-object' && operation.result.representation.kind === 'dynamic')
    for (const element of operation.elements)
      if (element.kind === 'element') add('dynamic-write', element.value.representation, dynamic)
  if (operation.kind === 'call') {
    if (operation.callee.representation.kind === 'dynamic') {
      if (operation.receiver) add('dynamic-write', operation.receiver.representation, dynamic)
      for (const argument of operation.arguments) add('dynamic-write', argument.representation, dynamic)
    }
    if (operation.intrinsicReflection === 'set') {
      const value = operation.arguments[2]
      if (value) add('dynamic-write', value.representation, dynamic)
    }
  }
  if (
    operation.kind === 'construct' &&
    (operation.callee.representation.kind === 'dynamic' ||
      (operation.callee.representation.kind === 'native-handle' && operation.callee.representation.protocol === 'ProxyConstructor'))
  )
    for (const argument of operation.arguments) add('dynamic-write', argument.representation, dynamic)
  if (
    operation.kind === 'bind-callable' &&
    ((operation.unboxedMethod !== undefined && operation.unboxedMethodConfirmed !== true) || operation.builtinShadowGuard === 'bind')
  ) {
    const receiver = operation.thisArgument ?? operation.receiver
    if (receiver) add('dynamic-write', receiver.representation, dynamic)
    add('dynamic-write', operation.source.representation, dynamic)
    for (const argument of operation.bound) add('dynamic-write', argument.representation, dynamic)
  }
  if (operation.kind === 'call' && operation.hostTemplate === 'object-assign') {
    const target = operation.arguments[0]?.representation
    if (target) {
      for (const targetArm of leavesOf(target)) {
        if (!carriesSidecar(targetArm)) continue
        for (const argument of operation.arguments.slice(1))
          for (const source of leavesOf(argument.representation))
            for (const field of fieldsOf(source, deriver))
              if (!declaredRecordFieldOf(deriver, targetArm, field.key, classes)) add('object-sidecar', field.value, dynamic)
      }
    }
  }
  return [...inputs.values()]
}

export const operationConversionsOf = (
  inputs: readonly OperationConversionInput[],
  conversions: Pick<ConversionCensus, 'nodeFor' | 'fieldReadFor' | 'absentIndexReadFor'>
): readonly OperationConversion[] =>
  inputs.map((input) => ({
    ...input,
    conversion:
      input.role === 'field-read'
        ? conversions.fieldReadFor(input.source, input.target).id
        : input.role === 'index-read'
          ? conversions.absentIndexReadFor(input.source, input.target).id
          : conversions.nodeFor(input.source, input.target).id
  }))

export const operationConversionsMatch = (
  expected: readonly OperationConversionInput[],
  actual: readonly OperationConversion[],
  conversions: Pick<ConversionCensus, 'nodeById'>
): boolean =>
  expected.length === actual.length &&
  expected.every((input, index) => {
    const value = actual[index]!
    const node = conversions.nodeById(value.conversion)
    return (
      input.role === value.role &&
      representationKey(input.source) === representationKey(value.source) &&
      representationKey(input.target) === representationKey(value.target) &&
      node !== null &&
      representationKey(node.source) === representationKey(input.source) &&
      representationKey(node.target) === representationKey(input.target)
    )
  })
