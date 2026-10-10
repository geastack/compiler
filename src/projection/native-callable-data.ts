import type { FunctionId, OperationId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableOwnDataOwner } from '../semantics/callable-own-data-slots.js'
import { callableOwnDataWriterAt } from '../semantics/callable-own-data-slots.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { propertyKeyTextOf } from '../semantics/property-key.js'
import {
  callableDataDefinitionDescriptorIsData,
  nativeCallableDataValueRepresentationOf,
  nativeCallableDataWriteProtocolOf,
  type NativeCallableDataPlan
} from '../representation/native-callable-data-storage.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import type { Representation } from '../representation/model.js'

/** The Function object that owns the own-data slot an operation addresses. */
export const nativeCallableDataOwnerAt = (plan: NativeCallableDataPlan, operationId: OperationId): FunctionId | null =>
  plan.schemaAt(operationId)?.functionId ?? null

const holdsCallable = (value: Representation): boolean =>
  isNativeCallableCarrier(value.kind) ||
  (value.kind === 'optional' && holdsCallable(value.payload)) ||
  (value.kind === 'tagged-union' && value.arms.some((arm) => holdsCallable(arm.value)))

/** Storage eligibility and the obligation to retain a typed payload are
 * separate. Exposure, multiple writers or an unavailable receiver entry can
 * refuse the current receipt, but cannot turn that payload into dynamic data.
 * Only the canonical actual source, rather than an asserted operand type,
 * can establish that the stored value already belongs to a dynamic boundary.
 */
export const nativeCallableDataStorageRequiresAuthorityAt = (
  graph: SemanticGraph,
  plan: NativeCallableDataPlan,
  operationId: OperationId,
  deriver: Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'>
): boolean => {
  const operation = graph.operations.get(operationId)
  if (
    operation === undefined ||
    (operation.family !== 'property' &&
      !(operation.family === 'invocation' && (operation.intrinsicMutation === 'reflect-set' || operation.intrinsicReflection === 'get')))
  )
    return false
  const schema = plan.schemaAt(operationId)
  const actualWriter =
    (operation.family === 'property' && operation.internalMethod === 'set') ||
    (operation.family === 'invocation' && operation.intrinsicMutation === 'reflect-set')
      ? callableOwnDataWriterAt(plan.census, operationId)
      : null
  const writers = actualWriter === null ? (schema?.writers ?? []) : [actualWriter]
  return writers.some(({ mutation, value }) => {
    if (value === null) return false
    // A Function's own `prototype` is never a native data slot (the storage
    // route excludes it): its native cell is the identity table's Value,
    // which `callableOwnPrototypeGet` and MakeConstructor read and write.
    // Demanding a data-slot receipt for it refused every replacement with
    // nothing that could ever answer.
    if (mutation.key === 'prototype') return false
    const source = nativeCallableDataValueRepresentationOf(value, deriver)
    // A data definition's native holder does not yet carry a Function frame;
    // such a definition keeps its descriptor-value boundary.
    if (mutation.kind === 'object-define-property' && source !== null && holdsCallable(source)) return false
    return source !== null && source.kind !== 'dynamic'
  })
}

/** Conditional stock-chain facts are discharged against all possible actual
 * native owners, not a keyed read schema or the public callable ABI.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableDataOwnerProtocolInput {
  readonly owners: readonly CallableOwnDataOwner[]
  readonly ordinarySources: ReadonlySet<FunctionId>
}

export const nativeCallableDataOwnerWriteProtocolOf = (
  semantic: SemanticOperation,
  key: string | null,
  symbol: boolean,
  input: NativeCallableDataOwnerProtocolInput
): 'absent' | 'builtin' | 'own-facts' | null => {
  if (input.owners.length === 0 || input.owners.some((owner) => !input.ordinarySources.has(owner.functionId))) return null
  const programSymbol =
    symbol &&
    ((semantic.family === 'property' && semantic.internalMethod === 'set') ||
      (semantic.family === 'invocation' &&
        semantic.intrinsicMutation === 'reflect-set' &&
        semantic.operands.filter((operand) => operand.role === 'argument').length === 3)) &&
    semantic.ordinaryCallableProgramSymbolDataWriteAbsent === true
  if (symbol && !programSymbol) return null
  for (const owner of input.owners) {
    if (
      owner.writes.some(
        (write) =>
          (symbol || write.key === null || write.key === key) &&
          write.kind !== 'set' &&
          write.kind !== 'reflect-set' &&
          write.kind !== 'delete' &&
          write.kind !== 'reflect-delete' &&
          !(write.kind === 'object-define-property' && write.key === key && callableDataDefinitionDescriptorIsData(write.operation))
      )
    )
      return null
    for (const blocker of owner.blockers) {
      if (blocker.kind === 'integrity') continue
      if (blocker.kind === 'unknown-key') {
        // This source fact proves a program Symbol key, never __proto__ or
        // a well-known Symbol hidden behind an asserted unique-symbol type.
        if (
          (blocker.operation.family === 'property' || blocker.operation.family === 'invocation') &&
          blocker.operation.ordinaryCallableProgramSymbolDataWriteAbsent === true
        )
          continue
        return null
      }
      if (blocker.kind === 'unknown-target' || blocker.kind === 'prototype-mutation') {
        const written = operandOf(
          blocker.operation,
          blocker.operation.family === 'property' ? 'key' : 'argument',
          blocker.operation.family === 'property' ? 0 : 1
        )
        const writtenKey = written?.source.kind === 'constant' ? propertyKeyTextOf(written.source.literal, written.source.text) : null
        if (!symbol && key !== null && writtenKey !== null && writtenKey !== key) continue
      }
      return null
    }
    if (
      !symbol &&
      (key === 'name' || key === 'length') &&
      owner.writes.some((write) => write.key === key && write.kind !== 'set' && write.kind !== 'reflect-set')
    )
      return null
  }
  if (programSymbol) return 'absent'
  if (key === null) return null
  if (key === 'name' || key === 'length') return 'own-facts'
  if (!nativeCallableDataWriteProtocolOf(semantic, key)) return null
  return (semantic.family === 'property' || semantic.family === 'invocation') && semantic.ordinaryCallableDataWriteAbsent === true
    ? 'absent'
    : 'builtin'
}
