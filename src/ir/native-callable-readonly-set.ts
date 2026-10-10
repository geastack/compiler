import type { ConversionNodeId } from '../conversion/algebra.js'
import { nativeCallableIdentityTransportMatches } from '../conversion/native-callable-adapter.js'
import {
  recipeHasNormalResult,
  recipeIsMaterializableWithoutPriorSourceGuard,
  recipePreservesNativePayload
} from '../conversion/recipe-closure.js'
import type { DeclarationId, FunctionId, IrValueId, SemanticResultId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { hostReceiverProtocolOf } from '../representation/host-templates.js'
import { abiKey, representationKey, type CallableAbi } from '../representation/model.js'
import { operandOf, resultOf, type OperandSource } from '../semantics/model/operands.js'
import { allOperationsOf, type IrOperand, type IrOperation, type SetOperation } from './model.js'
import type { NativeCallableDataSlotInput } from './native-callable-data-slots.js'
import { nativeCallableSourceAliasesOf } from './native-callable-argument.js'
import { callableOriginsOf } from '../semantics/callable-origins.js'
import { closedCallFrameOf } from './call-entry.js'
import { resultOfIrOperation } from './queries.js'

/** The evaluated native operands and current executable ABI of a source-proven
 * readonly own descriptor. It is not a native data installation.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableReadonlySet {
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly value: IrOperand
  readonly entry: CallableAbi
  readonly keys: readonly ('name' | 'length')[]
  readonly sources: readonly { readonly read: SemanticResultId; readonly declaration: DeclarationId; readonly member: string }[]
  readonly entries: readonly SemanticResultId[]
  readonly conversions: readonly ConversionNodeId[]
}

const sameSource = (left: OperandSource, right: OperandSource): boolean =>
  left.kind === right.kind &&
  (left.kind === 'result' && right.kind === 'result'
    ? left.result === right.result
    : left.kind === 'constant' && right.kind === 'constant' && left.literal === right.literal && left.text === right.text)

/** A public key slot may retain Symbol alongside String. Only the exact
 * source literals and admitted invocation frames below prove which values
 * enter this operation; this carrier check grants no descriptor authority. */
const supportsLiteralOwnFactKey = (key: IrOperand): boolean => {
  const carrier = key.representation
  return (
    carrier.kind === 'string' ||
    (carrier.kind === 'tagged-union' &&
      carrier.arms.some((arm) => arm.value.kind === 'string') &&
      carrier.arms.every((arm) => arm.value.kind === 'string' || arm.value.kind === 'symbol'))
  )
}

export const nativeCallableReadonlySetsOf = (input: NativeCallableDataSlotInput): ReadonlyMap<SetOperation, NativeCallableReadonlySet> => {
  const receipts = new Map<SetOperation, NativeCallableReadonlySet>()
  if (![...input.graph.operations.values()].some((one) => one.family === 'property' && one.nativeCallableReadonlySet !== undefined))
    return receipts
  const operations = [...input.bodies.values()].flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const definitions = new Map<IrValueId, IrOperation>()
  const reads = new Map<SemanticResultId, Extract<IrOperation, { kind: 'get' }> | null>()
  const calls = new Map<SemanticResultId, Extract<IrOperation, { kind: 'call' }> | null>()
  const abis = new Map<FunctionId, CallableAbi>()
  const ambiguousAbis = new Set<FunctionId>()
  for (const body of input.bodies.values()) {
    if (!body.abi) continue
    const id = body.sourceOwner as FunctionId
    const previous = abis.get(id)
    if (previous && abiKey(previous) !== abiKey(body.abi)) ambiguousAbis.add(id)
    abis.set(id, body.abi)
  }
  for (const id of ambiguousAbis) abis.delete(id)
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result) definitions.set(result.id, operation)
    if (operation.lineage === null) continue
    if (operation.kind === 'get') reads.set(operation.lineage, reads.has(operation.lineage) ? null : operation)
    if (operation.kind === 'call') calls.set(operation.lineage, calls.has(operation.lineage) ? null : operation)
  }
  const sourceOf = (lineage: SemanticResultId) => {
    const id = input.graph.results.get(lineage)
    return id === undefined ? undefined : input.graph.operations.get(id)
  }
  const callableOrigins = callableOriginsOf(input.graph)
  for (const operation of operations) {
    if (operation.kind !== 'set' || !isNativeCallableCarrier(operation.receiver.representation.kind)) continue
    const semantic = sourceOf(operation.lineage)
    const proof = semantic?.family === 'property' && semantic.internalMethod === 'set' ? semantic.nativeCallableReadonlySet : undefined
    const receiver = semantic && operandOf(semantic, 'receiver')
    const key = semantic && operandOf(semantic, 'key')
    const value = semantic && operandOf(semantic, 'value')
    const entry = abiOfCallee(operation.receiver.representation)
    if (
      !proof ||
      semantic?.family !== 'property' ||
      semantic.strict !== operation.strict ||
      receiver?.source.kind !== 'result' ||
      receiver.source.result !== proof.receiver ||
      !key ||
      !value ||
      !sameSource(key.source, proof.key) ||
      proof.keys.length === 0 ||
      proof.keys.some((one) => one !== 'name' && one !== 'length') ||
      proof.sources.length === 0 ||
      entry === null ||
      !supportsLiteralOwnFactKey(operation.key)
    )
      continue
    const conversions = new Set<ConversionNodeId>()
    const matches = (held: IrOperand, source: OperandSource, callable: boolean): boolean => {
      const aliases = source.kind === 'result' ? nativeCallableSourceAliasesOf(input.graph, source.result) : new Set<SemanticResultId>()
      const seen = new Set<IrValueId>()
      let actual = held
      while (!seen.has(actual.value)) {
        seen.add(actual.value)
        const producer = definitions.get(actual.value)
        const result = producer && resultOfIrOperation(producer)
        if (
          !producer ||
          !result ||
          result.id !== actual.value ||
          representationKey(result.representation) !== representationKey(actual.representation)
        )
          return false
        if (producer.kind === 'convert') {
          const node = input.conversions.nodeById(producer.conversionUse)
          if (
            !node ||
            representationKey(node.source) !== representationKey(producer.source.representation) ||
            representationKey(node.target) !== representationKey(producer.result.representation)
          )
            return false
          if (
            callable
              ? !nativeCallableIdentityTransportMatches(producer.source.representation, producer.result.representation, node)
              : !node ||
                !recipeHasNormalResult(node, input.conversions.nodeById) ||
                !recipePreservesNativePayload(node, input.conversions.nodeById) ||
                !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
          )
            return false
          conversions.add(producer.conversionUse)
          actual = producer.source
          continue
        }
        if (producer.kind === 'binding-read') {
          const original = producer.lineage === null ? undefined : sourceOf(producer.lineage)
          if (original?.family !== 'binding' || original.action !== 'read' || original.declaration !== producer.declaration) return false
        }
        return source.kind === 'result'
          ? producer.lineage !== null && aliases.has(producer.lineage)
          : source.kind === 'constant' &&
              producer.kind === 'constant' &&
              producer.literal === source.literal &&
              producer.text === source.text
      }
      return false
    }
    if (
      !matches(operation.receiver, receiver.source, true) ||
      !matches(operation.key, key.source, false) ||
      !matches(operation.value, value.source, isNativeCallableCarrier(operation.value.representation.kind))
    )
      continue
    const authenticatedSources = proof.sources.every((source) => {
      const read = reads.get(source.read)
      const original = sourceOf(source.read)
      if (read === undefined || read === null || original?.family !== 'property' || original.internalMethod !== 'get') return false
      const name = operandOf(original, 'key')
      const actualName = definitions.get(read.key.value)
      const actualAbi = abiOfCallee(read.result.representation)
      const prototype = definitions.get(read.receiver.value)
      const sourcePrototype = prototype?.lineage === null || prototype?.lineage === undefined ? undefined : sourceOf(prototype.lineage)
      const prototypeResult = sourcePrototype && resultOf(sourcePrototype, 'value')
      const sourcePrototypeKey = sourcePrototype && operandOf(sourcePrototype, 'key')
      const prototypeKey = prototype?.kind === 'get' ? definitions.get(prototype.key.value) : undefined
      const constructor = prototype?.kind === 'get' ? definitions.get(prototype.receiver.value) : undefined
      const binding = constructor?.lineage === null || constructor?.lineage === undefined ? undefined : sourceOf(constructor.lineage)
      return (
        resultOf(original, 'value')?.id === source.read &&
        name?.source.kind === 'constant' &&
        name.source.literal === 'string' &&
        name.source.text === source.member &&
        actualName?.kind === 'constant' &&
        actualName.literal === 'string' &&
        actualName.text === source.member &&
        actualAbi !== null &&
        abiKey(actualAbi) === abiKey(entry) &&
        hostReceiverProtocolOf(read.receiver.representation)?.protocol === 'Date.prototype' &&
        prototype?.kind === 'get' &&
        sourcePrototype?.family === 'property' &&
        sourcePrototype.internalMethod === 'get' &&
        prototypeResult !== undefined &&
        sourcePrototypeKey?.source.kind === 'constant' &&
        sourcePrototypeKey.source.literal === 'string' &&
        sourcePrototypeKey.source.text === 'prototype' &&
        matches(read.receiver, { kind: 'result', result: prototypeResult.id }, false) &&
        prototypeKey?.kind === 'constant' &&
        prototypeKey.literal === 'string' &&
        prototypeKey.text === 'prototype' &&
        constructor?.kind === 'binding-read' &&
        binding?.family === 'binding' &&
        binding.action === 'read' &&
        constructor.declaration === binding.declaration &&
        input.placements.get(constructor.declaration)?.storage.kind === 'host-class' &&
        hostReceiverProtocolOf(constructor.result.representation)?.protocol === 'DateConstructor'
      )
    })
    if (!authenticatedSources) continue
    let enclosingCaller = semantic.caller
    if (
      !proof.entries.every((id) => {
        const call = calls.get(id)
        const original = sourceOf(id)
        const callee = original?.family === 'invocation' ? operandOf(original, 'callee') : undefined
        const declared = callee?.source.kind === 'result' ? callableOrigins.get(callee.source.result) : undefined
        const authenticated =
          call !== undefined &&
          call !== null &&
          original?.family === 'invocation' &&
          enclosingCaller.kind === 'function' &&
          original.target.kind === 'exact' &&
          original.target.target.kind === 'function' &&
          original.target.target.functionId === enclosingCaller.functionId &&
          call.closedCallee?.kind === 'exact' &&
          call.closedCallee.functionId === original.target.target.functionId &&
          callee !== undefined &&
          declared === call.closedCallee.functionId &&
          matches(call.callee, callee.source, true) &&
          original.operands
            .filter((one) => one.role === 'argument')
            .every((one) => {
              const argument = call.arguments[one.ordinal]
              return argument !== undefined && matches(argument, one.source, isNativeCallableCarrier(argument.representation.kind))
            }) &&
          closedCallFrameOf(
            call,
            call.closedCallee,
            (one) => abis.get(one) ?? null,
            new Set(call.result ? [call.result.id] : []),
            input.conversions
          ) !== undefined
        if (authenticated && original !== undefined) enclosingCaller = original.caller
        return authenticated
      }) ||
      enclosingCaller.kind !== 'region'
    )
      continue
    receipts.set(operation, {
      receiver: operation.receiver,
      key: operation.key,
      value: operation.value,
      entry,
      keys: proof.keys,
      sources: proof.sources,
      entries: proof.entries,
      conversions: [...conversions]
    })
  }
  return receipts
}

export const nativeCallableReadonlySetMatches = (
  expected: NativeCallableReadonlySet | undefined,
  actual: NativeCallableReadonlySet | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  [
    [expected.receiver, actual.receiver],
    [expected.key, actual.key],
    [expected.value, actual.value]
  ].every(
    ([left, right]) => left!.value === right!.value && representationKey(left!.representation) === representationKey(right!.representation)
  ) &&
  abiKey(expected.entry) === abiKey(actual.entry) &&
  (['keys', 'entries', 'conversions'] as const).every(
    (key) => expected[key].length === actual[key].length && expected[key].every((one, ordinal) => one === actual[key][ordinal])
  ) &&
  expected.sources.length === actual.sources.length &&
  expected.sources.every((one, ordinal) => {
    const other = actual.sources[ordinal]
    return other !== undefined && one.read === other.read && one.declaration === other.declaration && one.member === other.member
  })
