import { resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { AllocateOrdinaryObjectOperation, AllocateRecordOperation, GetOperation, SetOperation } from './model.js'
import type { NativePropertyPresenceGuard } from './native-property-presence.js'

/** A physical optional slot can be absent and reach an inherited interceptor.
 * Only the exact operation's discharged prototype protocol excludes that call.
 */
export const nativeOrdinaryPropertyPreservesPresence = (
  operation: GetOperation | SetOperation,
  name: string,
  guard: NativePropertyPresenceGuard
): boolean =>
  name === guard.key
    ? guard.present
    : operation.kind === 'get'
      ? operation.ordinaryObjectPrototypeKeyAbsent === true
      : operation.ordinaryObjectDataWriteAbsent === true

/** Tuple arrays and constructor instances can share a record carrier without
 * inheriting Object.prototype. The actual allocation source owns this fact.
 */
export const nativeOrdinaryAllocationMatches = (
  operation: AllocateOrdinaryObjectOperation | AllocateRecordOperation,
  semantic: SemanticOperation | null
): boolean =>
  operation.ordinaryObjectPrototype === true &&
  semantic !== null &&
  resultOf(semantic, 'value')?.id === operation.lineage &&
  ((semantic.family === 'allocation' && semantic.allocated === 'object-literal' && semantic.ordinaryObjectPrototype === true) ||
    (semantic.family === 'invocation' &&
      semantic.freshOrdinaryObject === true &&
      !semantic.operands.some((operand) => operand.role === 'argument')))
