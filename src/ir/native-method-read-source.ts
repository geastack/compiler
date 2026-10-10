import type { DeclarationId, FunctionId, SemanticResultId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf } from '../projection/fields.js'
import { abiOfCallee } from '../projection/callee.js'
import { abiKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { identityOperandOf, immutableBindingInitializerOf, operandOf, resultOf } from '../semantics/model/operands.js'

/**
 * The same sealed native member and value facts used when lowering the originating Get.
 * @semanticCategory generic-primitive
 */
export interface NativeMethodReadAuthority {
  readonly graph: Pick<SemanticGraph, 'operations' | 'results'>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly representations: ReadonlyMap<SemanticResultId, Representation>
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
}

const nativeClassArmsOf = (value: Representation): readonly Extract<Representation, { kind: 'class-ref' }>[] | null => {
  if (value.kind === 'class-ref') return [value]
  if (value.kind === 'borrowed-ref') return nativeClassArmsOf(value.referent)
  if (value.kind === 'optional') return nativeClassArmsOf(value.payload)
  if (value.kind !== 'tagged-union' || value.arms.length === 0) return null
  const arms: Extract<Representation, { kind: 'class-ref' }>[] = []
  for (const arm of value.arms) {
    if (arm.value.kind === 'null' || arm.value.kind === 'undefined') continue
    const native = nativeClassArmsOf(arm.value)
    if (native === null) return null
    arms.push(...native)
  }
  return arms.length === 0 ? null : arms
}

/** A declared native method read is a source protocol; an equal Function parameter is not one. */
export const nativeMethodReadSourceOf = (
  origin: SemanticResultId,
  source: Representation,
  authority: NativeMethodReadAuthority
): SemanticResultId | null => {
  const seen = new Set<SemanticResultId>()
  let current: SemanticResultId | null = origin
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const operationId = authority.graph.results.get(current)
    const operation = operationId === undefined ? undefined : authority.graph.operations.get(operationId)
    if (operation?.family === 'property' && operation.internalMethod === 'get') {
      const key = operandOf(operation, 'key')
      const keys = key?.source.kind === 'constant' ? [key.source.text] : operation.provenKeyTexts
      const receiver = operandOf(operation, 'receiver')
      const carrier =
        receiver?.source.kind === 'result'
          ? authority.representations.get(receiver.source.result)
          : receiver?.source.kind === 'receiver' && operation.caller.kind === 'function'
            ? authority.abis.get(operation.caller.functionId)?.receiver
            : null
      const read = resultOf(operation, 'value')
      const published = read === undefined ? undefined : authority.representations.get(read.id)
      const readAbi = published === undefined ? null : abiOfCallee(published)
      const heldAbi = abiOfCallee(source)
      const arms = carrier === undefined || carrier === null ? null : nativeClassArmsOf(carrier)
      if (
        keys === undefined ||
        keys.length === 0 ||
        arms === null ||
        readAbi === null ||
        heldAbi === null ||
        abiKey(readAbi) !== abiKey(heldAbi) ||
        !arms.every((arm) => keys.every((name) => classMemberOf(authority.classes, arm.declaration, name)?.kind === 'method'))
      )
        return null
      return read!.id
    }
    const alias =
      operation === undefined ? undefined : (identityOperandOf(operation) ?? immutableBindingInitializerOf(authority.graph, operation))
    current = alias?.source.kind === 'result' ? alias.source.result : null
  }
  return null
}
