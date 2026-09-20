import type { IrValueId } from '../identity/ids.js'
import type { CallOperation, IrBody } from './model.js'
import { allOperationsOf } from './model.js'
import { operandsOfIrOperation } from './queries.js'

export type NumericIntrinsic = 'imul'

/**
 * Language builtin calls authenticated by their native protocol, never by a
 * source identifier spelling. A user object named Math has no such protocol.
 * Keep first-class function reads intact; only reads consumed entirely by
 * these direct calls may omit their callable carrier.
 */
export const numericIntrinsicsOf = (
  body: IrBody
): {
  readonly calls: ReadonlyMap<CallOperation, NumericIntrinsic>
  readonly callOnly: ReadonlySet<IrValueId>
} => {
  const keys = new Map<IrValueId, string>()
  const callees = new Map<IrValueId, NumericIntrinsic>()
  const calls = new Map<CallOperation, NumericIntrinsic>()
  const callOnly = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'constant' && operation.literal === 'string') keys.set(operation.result.id, operation.text)
    }
  }
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'get') continue
      const receiver = operation.receiver.representation
      if (
        receiver.kind === 'native-handle' &&
        receiver.native === null &&
        receiver.protocol === 'Math' &&
        keys.get(operation.key.value) === 'imul'
      ) {
        callees.set(operation.result.id, 'imul')
      }
    }
  }
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'call') continue
      const intrinsic = callees.get(operation.callee.value)
      // Other arities and coercing ABIs retain the general callable path.
      if (intrinsic === undefined || operation.arguments.length !== 2) continue
      if (
        !operation.arguments.every((argument) => argument.representation.kind === 'scalar' && argument.representation.domain === 'number')
      )
        continue
      calls.set(operation, intrinsic)
      callOnly.add(operation.callee.value)
    }
  }
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      const operands =
        operation.kind === 'call' && calls.has(operation)
          ? [...(operation.receiver ? [operation.receiver] : []), ...operation.arguments]
          : operandsOfIrOperation(operation)
      for (const operand of operands) callOnly.delete(operand.value)
    }
  }
  return { calls, callOnly }
}
