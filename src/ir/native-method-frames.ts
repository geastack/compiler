import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { ClassLayout, ClassMethod } from '../projection/classes.js'
import { abiOfCallee } from '../projection/callee.js'
import {
  classFamilyOverridesOf,
  classMethodValueArmsOf,
  classPrototypeMethodKeysOf,
  classPrototypeMethodValueArmsOf
} from '../projection/dispatch.js'
import { classMemberOf, classMethodOverrideOf } from '../projection/fields.js'
import { heldMethodCopyOf, publishedMethodCopyOf } from '../projection/method-values.js'
import { nativeUnboundMethodContractOf } from '../conversion/native-method.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import { allOperationsOf, type GetOperation, type IrBody, type IrOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/** Immediate native calls can consume the method selection without building a Function object. */
const deferredMethodValues = new WeakMap<IrBody, ReadonlySet<IrValueId>>()

export const deferredMethodValuesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const remembered = deferredMethodValues.get(body)
  if (remembered !== undefined) return remembered
  const immediate = new Set<IrValueId>()
  const escaped = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'call') {
        if (operation.target && operation.target.kind !== 'unresolved') immediate.add(operation.callee.value)
        else escaped.add(operation.callee.value)
      }
      for (const operand of operandsOfIrOperation(operation)) {
        if (
          operation.kind === 'call' &&
          operand.value === operation.callee.value &&
          operation.receiver?.value !== operand.value &&
          !operation.arguments.some((argument) => argument.value === operand.value)
        )
          continue
        escaped.add(operand.value)
      }
    }
  const values = new Set([...immediate].filter((value) => !escaped.has(value)))
  deferredMethodValues.set(body, values)
  return values
}

const receiverArmsOf = (receiver: Representation): readonly Representation[] =>
  receiver.kind === 'optional'
    ? receiverArmsOf(receiver.payload)
    : receiver.kind === 'tagged-union'
      ? receiver.arms.flatMap((arm) => receiverArmsOf(arm.value))
      : [receiver]

export interface NativeMethodFrameInput {
  readonly source: Representation
  readonly target: Representation
}

export interface NativeMethodSourceInput extends NativeMethodFrameInput {
  readonly key: string
  readonly callable: FunctionId | null
  readonly origin: 'prototype' | 'own'
}

/** The physical methods selected by the same allocation and copy rules as a native property read. */
export const nativeMethodSourceInputsOf = (
  operation: GetOperation,
  keyText: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  body?: IrBody,
  definitionOf?: (value: IrValueId) => IrOperation | null
): readonly NativeMethodSourceInput[] => {
  if (body && deferredMethodValuesOf(body).has(operation.result.id)) return []
  const target = operation.result.representation
  const held = abiOfCallee(target)
  const inputs = new Map<string, NativeMethodSourceInput>()
  const add = (key: string, callable: FunctionId | null, origin: 'prototype' | 'own', source: Representation): void => {
    inputs.set(`${origin}:${key}:${callable ?? ''}:${representationKey(source)}->${representationKey(target)}`, {
      key,
      callable,
      origin,
      source,
      target
    })
  }
  const definition =
    definitionOf ??
    ((value: IrValueId): IrOperation | null => {
      if (body === undefined) return null
      for (const block of body.blocks.values())
        for (const candidate of allOperationsOf(block)) if ('result' in candidate && candidate.result?.id === value) return candidate
      return null
    })
  const abiOf = (callable: FunctionId): CallableAbi | null => abis.get(callable) ?? null
  const union = operation.receiver.representation.kind === 'tagged-union'
  for (const receiver of receiverArmsOf(operation.receiver.representation)) {
    if (receiver.kind !== 'class-ref') continue
    const staticDispatch =
      definition(operation.receiver.value)?.kind === 'receiver' &&
      body?.abi?.receiver?.kind === 'class-ref' &&
      body.abi.receiver.declaration !== receiver.declaration
    const keys =
      keyText === null
        ? (operation.provenKeyTexts ?? (target.kind === 'dynamic' ? classPrototypeMethodKeysOf(classes, receiver.declaration) : []))
        : [keyText]
    for (const key of keys) {
      const member = classMemberOf(classes, receiver.declaration, key)
      if (target.kind === 'dynamic' && !staticDispatch) {
        const arms = classPrototypeMethodValueArmsOf(classes, receiver.declaration, key)
        for (const arm of arms ?? []) {
          const method = arm.method
          const abi = method === null ? null : abiOf(method.callable)
          if (abi !== null) add(key, method!.callable, 'prototype', { kind: 'function-value-dispatch', abi })
          const own = classMethodOverrideOf(classes, arm.allocation, key)
          if (own !== null) add(key, null, 'own', own.value)
        }
        continue
      }
      if (member?.kind !== 'method') continue
      const overridden = !staticDispatch && classFamilyOverridesOf(classes, receiver.declaration, key).length > 0
      const methods: readonly ClassMethod[] = overridden
        ? (classMethodValueArmsOf(classes, receiver.declaration, key)?.map((arm) => arm.method) ?? [])
        : [member.method]
      for (const method of methods) {
        const selected = union
          ? publishedMethodCopyOf(classes, abiOf, method, key, target)
          : held !== null
            ? heldMethodCopyOf(classes, abiOf, method, key, held)
            : method
        const abi = selected.callable === null ? null : abiOf(selected.callable)
        if (abi !== null) add(key, selected.callable, 'prototype', { kind: 'function-value-dispatch', abi })
      }
      const own = staticDispatch ? null : classMethodOverrideOf(classes, receiver.declaration, key)
      if (own !== null) add(key, null, 'own', own.value)
    }
  }
  return [...inputs.values()]
}

/** Non-contextual physical frames remain ordinary census demands, including unsupported pairs. */
export const nativeMethodFrameInputsOf = (
  operation: GetOperation,
  keyText: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  body?: IrBody,
  definitionOf?: (value: IrValueId) => IrOperation | null
): readonly NativeMethodFrameInput[] => {
  const inputs = new Map<string, NativeMethodFrameInput>()
  for (const { source, target } of nativeMethodSourceInputsOf(operation, keyText, classes, abis, body, definitionOf)) {
    if (nativeUnboundMethodContractOf(source, target) !== null || representationKey(source) === representationKey(target)) continue
    inputs.set(`${representationKey(source)}->${representationKey(target)}`, { source, target })
  }
  return [...inputs.values()]
}
