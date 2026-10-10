import type { FunctionId, IrValueId, OperationId } from '../identity/ids.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { representationKey } from '../representation/model.js'
import { callableOwnPrototypeOf } from '../semantics/callable-origins.js'
import { authenticatedNativeHostMethodReadOf, intrinsicCallArgumentMatches, type NativeHostMethodRead } from './intrinsic-call-facts.js'
import { allOperationsOf, type IrOperand, type IrOperation } from './model.js'
import type { NativeCallableDataSlotInput } from './native-callable-data-slots.js'
import { resultOfIrOperation } from './queries.js'
import {
  nativeCallablePrototypeMatches,
  nativeCallablePrototypeSourceAuthorityOf,
  type NativeCallablePrototype
} from './native-callable-prototype.js'

/** Complete own descriptors of the exact native Function source family.
 * Prototype-owning Functions authenticate their allocation and physical entry;
 * a call-only public ABI cannot erase that native backpointer obligation.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableIntegrity {
  readonly invocation: OperationId
  readonly receiver: IrOperand
  readonly owners: readonly FunctionId[]
  readonly ownPrototype: boolean
  readonly prototype?: NativeCallablePrototype
  readonly entry: NativeHostMethodRead
}

const members = new Set(['freeze', 'seal', 'preventExtensions', 'isFrozen', 'isSealed', 'isExtensible'])

export const nativeCallableIntegrityAuthorityOf = (
  input: NativeCallableDataSlotInput
): { readonly required: ReadonlySet<IrOperation>; readonly receipts: ReadonlyMap<IrOperation, NativeCallableIntegrity> } => {
  const required = new Set<IrOperation>()
  const receipts = new Map<IrOperation, NativeCallableIntegrity>()
  const prototypeOf = nativeCallablePrototypeSourceAuthorityOf(input)
  for (const body of input.bodies.values()) {
    const operations = [...body.blocks.values()].flatMap(allOperationsOf)
    const definitions = new Map<IrValueId, IrOperation>()
    for (const operation of operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null) definitions.set(result.id, operation)
    }
    for (const operation of operations) {
      if (operation.kind !== 'call') continue
      const receiver = operation.arguments[0]
      if (receiver === undefined || !isNativeCallableCarrier(receiver.representation.kind)) continue
      const semanticId = input.graph.results.get(operation.lineage)
      const semantic = semanticId === undefined ? null : (input.graph.operations.get(semanticId) ?? null)
      const entry = authenticatedNativeHostMethodReadOf(
        operation,
        semantic,
        input.calleeRendering,
        (value) => definitions.get(value) ?? null
      )
      const integrity = semantic?.family === 'invocation' && semantic.intrinsicIntegrity !== undefined
      if (entry === null) {
        if (integrity) required.add(operation)
        continue
      }
      if (entry.receipt.protocol !== 'ObjectConstructor' || !members.has(entry.receipt.member)) continue
      required.add(operation)
      if (
        semantic?.family !== 'invocation' ||
        operation.arguments.length !== 1 ||
        operation.argumentsAreSpread ||
        !intrinsicCallArgumentMatches(operation, semantic, 0, (value) => definitions.get(value) ?? null)
      )
        continue
      const owners = input.callableFlow.callableIdentityOrigins.get(receiver.value)
      if (owners === undefined || owners.length === 0) continue
      const absent = owners.every((source) => callableOwnPrototypeOf(input.graph, source) === false)
      const prototype = absent ? null : prototypeOf(operation, receiver, semantic, 'argument')
      if (!absent && prototype === null) continue
      receipts.set(operation, {
        invocation: semantic.id,
        receiver,
        owners,
        ownPrototype: !absent,
        ...(prototype === null ? {} : { prototype }),
        entry: entry.receipt
      })
    }
  }
  return { required, receipts }
}

export const nativeCallableIntegrityMatches = (
  expected: NativeCallableIntegrity | undefined,
  actual: NativeCallableIntegrity | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  actual.ownPrototype === expected.ownPrototype &&
  ((actual.prototype === undefined && expected.prototype === undefined) ||
    nativeCallablePrototypeMatches(expected.prototype, actual.prototype)) &&
  actual.invocation === expected.invocation &&
  actual.receiver.value === expected.receiver.value &&
  representationKey(actual.receiver.representation) === representationKey(expected.receiver.representation) &&
  actual.owners.length === expected.owners.length &&
  actual.owners.every((owner, ordinal) => owner === expected.owners[ordinal]) &&
  actual.entry.invocation === expected.entry.invocation &&
  actual.entry.receiver === expected.entry.receiver &&
  actual.entry.key === expected.entry.key &&
  actual.entry.protocol === expected.entry.protocol &&
  actual.entry.member === expected.entry.member
