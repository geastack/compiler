import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeUnboundMethodContractOf, type NativeMethodValueRecipe } from '../conversion/native-method.js'
import { nativeBufferMethodDescriptorOf } from '../conversion/native-buffer-method.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { abiOfCallee, type CalleeRenderingInput } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf, declaredRecordFieldOf, recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { HostSpellings } from '../targets/cpp/host/host-members.js'
import { publishDenseLoopPlan } from './dense-loops.js'
import { hostNamespaceReadsOf } from './host-namespace-reads.js'
import { allOperationsOf, type GetOperation, type IrBody, type IrOperation } from './model.js'
import { operationConversionInputsOf, operationConversionsOf } from './operation-conversions.js'
import { deferredMethodValuesOf, nativeMethodSourceInputsOf } from './native-method-frames.js'
import { spreadCopyConversionPlanOf } from './spread-conversions.js'
import { settledVirtualCallFramesOf } from './virtual-call-frames.js'
import { hostObjectWalkPlanOf } from './host-template-conversions.js'
import { buildHostMethodAliasIndex } from './host-method-aliases.js'
import { createReadOnlyDictionaryAuthority } from './read-only-dictionary.js'
import { mergeConversionPlanOf } from './merge-conversions.js'
import { operationOfResult } from '../identity/ids.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { nonNormalReceiverProofOf } from './non-normal-receiver.js'
import { genericNativeLogicalReceiverOf } from './call-entry.js'
import { nativeLogicalReceiverProtocolOf, nativeLogicalReceiverProtocolSupported } from '../representation/native-logical-receiver.js'
import { publishNativeHostMethodReads } from './native-host-method-reads.js'

export type MethodConversionInput = Omit<NativeMethodValueRecipe, 'conversion'>

const propertyArmsOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? propertyArmsOf(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.flatMap((arm) => propertyArmsOf(arm.value))
      : [value]

const methodKeysOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId): readonly string[] => {
  const keys = new Set<string>()
  const seen = new Set<DeclarationId>()
  for (let current: DeclarationId | null = declaration; current !== null && !seen.has(current);) {
    seen.add(current)
    const layout = classes.get(current)
    if (layout === undefined) break
    for (const method of layout.methods) keys.add(method.key)
    for (const field of layout.fields) keys.add(field.key)
    current = layout.base
  }
  return [...keys]
}

/** Every concrete method object that a static or finite computed native read may return. */
export const methodConversionInputsOf = (
  operation: GetOperation,
  keyText: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  deriver?: RepresentationDeriver,
  body?: IrBody
): readonly MethodConversionInput[] => {
  if (body && deferredMethodValuesOf(body).has(operation.result.id)) return []
  const target = operation.result.representation
  const targetAbi = abiOfCallee(target)
  if (targetAbi === null) return []
  const inputs = new Map<string, MethodConversionInput>()
  const add = (key: string, callable: FunctionId | null, origin: 'prototype' | 'own', source: Representation): void => {
    if (nativeUnboundMethodContractOf(source, target) === null) return
    const input = { key, callable, origin, source, target }
    inputs.set(`${origin}:${key}:${callable ?? ''}:${representationKey(source)}->${representationKey(target)}`, input)
  }
  for (const receiver of propertyArmsOf(operation.receiver.representation)) {
    const bufferMethod = keyText === null ? null : nativeBufferMethodDescriptorOf(receiver, keyText, target)
    if (bufferMethod) {
      const input: MethodConversionInput = {
        key: keyText!,
        callable: null,
        origin: 'prototype',
        source: bufferMethod.source,
        target,
        builtin: 'buffer-slice'
      }
      inputs.set(`buffer-slice:${representationKey(receiver)}->${representationKey(target)}`, input)
      continue
    }
    const recordFields =
      receiver.kind === 'record' || receiver.kind === 'record-with-index'
        ? receiver.fields
        : receiver.kind === 'native-record-ref' && deriver !== undefined
          ? recordFieldsOfShape(deriver, receiver.shapeId)
          : null
    if (receiver.kind !== 'class-ref' && recordFields === null) continue
    const keys =
      keyText !== null
        ? [keyText]
        : (operation.provenKeyTexts ??
          (receiver.kind === 'class-ref' ? methodKeysOf(classes, receiver.declaration) : recordFields!.map((field) => field.key)))
    for (const key of keys) {
      if (receiver.kind !== 'class-ref') {
        const field = recordFields?.find((candidate) => candidate.key === key)
        if (field !== undefined) add(key, null, 'own', field.value)
        continue
      }
      const member = classMemberOf(classes, receiver.declaration, key)
      if (member?.kind === 'field') {
        const field =
          deriver === undefined
            ? classes.get(member.owner)?.nativeStorage?.fields.find((candidate) => candidate.key === key)
            : declaredRecordFieldOf(deriver, receiver, key, classes)
        if (field !== undefined && field !== null) add(key, null, 'own', field.value)
        continue
      }
      if (member?.kind === 'method')
        for (const method of nativeMethodSourceInputsOf(operation, key, classes, abis, body))
          add(method.key, method.callable, method.origin, method.source)
    }
  }
  return [...inputs.values()]
}

export const methodValueRecipesMatch = (
  expected: readonly MethodConversionInput[],
  actual: readonly NativeMethodValueRecipe[],
  conversions: Pick<ConversionCensus, 'nodeById' | 'nativeMethodFor' | 'nativeBufferMethodFor'>
): boolean =>
  expected.length === actual.length &&
  expected.every((input, index) => {
    const recipe = actual[index]!
    const node = conversions.nodeById(recipe.conversion)
    const approved =
      input.builtin === 'buffer-slice'
        ? conversions.nativeBufferMethodFor(input.source, input.target)
        : conversions.nativeMethodFor(input.source, input.target)
    return (
      recipe.key === input.key &&
      recipe.callable === input.callable &&
      recipe.origin === input.origin &&
      recipe.builtin === input.builtin &&
      representationKey(recipe.source) === representationKey(input.source) &&
      representationKey(recipe.target) === representationKey(input.target) &&
      node !== null &&
      approved !== null &&
      approved === node &&
      representationKey(node.source) === representationKey(input.source) &&
      representationKey(node.target) === representationKey(input.target)
    )
  })

export interface PublishConversionRecipesInput {
  readonly calleeRendering?: CalleeRenderingInput
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly deriver: RepresentationDeriver
  readonly conversions: ConversionCensus
  readonly hosts: HostSpellings
  readonly wellKnownSymbols?: ReadonlyMap<DeclarationId, string>
}

/** Publish after all body rewrites, so the certificate and the printer name the same adaptations. */
export const publishConversionRecipes = (input: PublishConversionRecipesInput): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const nativeBodies = publishNativeHostMethodReads(input.bodies, input.calleeRendering, input.hosts.members)
  let callableFlow: ReturnType<typeof nativeCallableFlowOf> | undefined
  const virtualFrames = settledVirtualCallFramesOf(input.bodies.values(), input.classes, input.conversions)
  const hostMethodAliases = buildHostMethodAliasIndex([...input.bodies.values()], input.placements, input.hosts)
  const bodies = new Map<PhysicalBodyId, IrBody>()
  for (const [id, body] of nativeBodies) {
    const constants = new Map<IrValueId, string>()
    const definitions = new Map<IrValueId, IrOperation>()
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if ('result' in operation && operation.result) definitions.set(operation.result.id, operation)
        if (operation.kind === 'constant' && (operation.literal === 'string' || operation.literal === 'number'))
          constants.set(operation.result.id, operation.text)
      }
    const hostNamespaceCensus = hostNamespaceReadsOf(body, input.placements, input.hosts, constants)
    const publish = (operation: IrOperation): IrOperation => {
      const keyText = 'key' in operation ? (constants.get(operation.key.value) ?? null) : null
      const hostDynamicArguments =
        operation.kind === 'call' && hostNamespaceCensus.functionReads.get(operation.callee.value)?.arguments === 'dynamic'
      const inputs = operationConversionInputsOf(
        operation,
        keyText,
        input.deriver,
        input.classes,
        hostDynamicArguments,
        input.abis,
        (value) => definitions.get(value) ?? null,
        body,
        virtualFrames,
        input.hosts,
        input.wellKnownSymbols,
        hostMethodAliases
      )
      const conversionRecipes = operationConversionsOf(inputs, input.conversions)
      if (operation.kind === 'merge-live-arm-rebuild') {
        const graph = input.calleeRendering?.graph
        const semantic = graph?.operations.get(operationOfResult(operation.lineage)) ?? null
        const mergeConversionPlan = mergeConversionPlanOf(
          operation,
          semantic,
          input.conversions,
          (value) => definitions.get(value) ?? null,
          body
        )
        return {
          ...operation,
          conversionRecipes,
          ...(mergeConversionPlan === undefined ? {} : { mergeConversionPlan })
        }
      }
      if (operation.kind === 'spread-copy')
        return {
          ...operation,
          conversionRecipes,
          spreadConversionPlan: spreadCopyConversionPlanOf(operation, input.deriver, input.conversions)
        }
      if (operation.kind === 'call') {
        const receiver = genericNativeLogicalReceiverOf(operation)
        const graph = input.calleeRendering?.graph
        const nonNormalReceiverProof =
          receiver === null || nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(receiver.representation))
            ? undefined
            : nonNormalReceiverProofOf(operation, {
                body,
                bodies: nativeBodies.values(),
                conversions: input.conversions,
                callables: (callableFlow ??= nativeCallableFlowOf(
                  [...nativeBodies.values()],
                  input.placements,
                  input.classes,
                  input.conversions,
                  undefined,
                  input.deriver
                )).callables,
                definitionOf: (value) => definitions.get(value) ?? null,
                semantic: graph?.operations.get(operationOfResult(operation.lineage)) ?? null,
                semanticOperationOf: (lineage) => graph?.operations.get(operationOfResult(lineage)) ?? null
              })
        const hostObjectWalkPlan = hostObjectWalkPlanOf(
          operation,
          (value) => definitions.get(value) ?? null,
          input.deriver,
          input.classes,
          input.conversions,
          hostMethodAliases
        )
        return {
          ...operation,
          conversionRecipes,
          ...(nonNormalReceiverProof === undefined ? {} : { nonNormalReceiverProof }),
          ...(hostObjectWalkPlan === undefined ? {} : { hostObjectWalkPlan })
        }
      }
      if (operation.kind !== 'get') return { ...operation, conversionRecipes }
      const methodInputs = methodConversionInputsOf(operation, keyText, input.classes, input.abis, input.deriver, body)
      const methodValueRecipes = methodInputs.map((method) => {
        const conversion =
          method.builtin === 'buffer-slice'
            ? input.conversions.nativeBufferMethodFor(method.source, method.target)
            : input.conversions.nativeMethodFor(method.source, method.target)
        if (conversion === null) throw new Error(`native method ${method.key} has no conversion for its published carrier`)
        return { ...method, conversion: conversion.id }
      })
      return { ...operation, conversionRecipes, methodValueRecipes }
    }
    const blocks = new Map(
      [...body.blocks].map(([blockId, block]) => [
        blockId,
        {
          ...block,
          operations: block.operations.map((operation) => publish(operation) as typeof operation),
          terminator: publish(block.terminator) as typeof block.terminator
        }
      ])
    )
    bodies.set(id, publishDenseLoopPlan({ ...body, blocks, hostNamespaceCensus }, input.placements, input.conversions))
  }
  const needsReadProof = [...bodies.values()].some((body) =>
    [...body.blocks.values()].some((block) =>
      block.operations.some((operation) => {
        if (operation.kind !== 'convert') return false
        const node = input.conversions.nodeById(operation.conversionUse)
        return node?.capability.kind === 'static' && node.capability.materializer.readOnlyDictionary !== undefined
      })
    )
  )
  if (!needsReadProof) return bodies
  const readonly = createReadOnlyDictionaryAuthority({
    ...(input.calleeRendering === undefined ? {} : { calleeRendering: input.calleeRendering }),
    bodies,
    placements: input.placements,
    classes: input.classes,
    conversions: input.conversions
  })
  return new Map(
    [...bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation) => {
                if (operation.kind !== 'convert') return operation
                const node = input.conversions.nodeById(operation.conversionUse)
                if (node?.capability.kind !== 'static' || node.capability.materializer.readOnlyDictionary === undefined) return operation
                const proof = readonly.proofOf(operation.result.id)
                return proof === null ? operation : { ...operation, readOnlyDictionaryProof: proof }
              })
            }
          ])
        )
      }
    ])
  )
}
