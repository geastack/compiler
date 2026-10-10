import type { IrValueId } from '../identity/ids.js'
import type { IrBody } from '../ir/model.js'
import { allOperationsOf } from '../ir/model.js'
import { operandsOfIrOperation } from '../ir/queries.js'

/**
 * The values in one body consumed ONLY as the callee of a virtual call.
 *
 * A method returned, stored, passed or inspected is selected at property-read
 * time; only a value whose every use is the callee position of a call the IR
 * targeted `virtual` may defer that selection to the receiver's dispatch
 * member. A value that is also the call's receiver or one of its arguments is
 * observed as a value, so it escapes even at its own call.
 */
export const immediateVirtualCalleesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const immediate = new Set<IrValueId>()
  const escaped = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'call') {
        if (operation.target?.kind === 'virtual') immediate.add(operation.callee.value)
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
  }
  for (const value of escaped) immediate.delete(value)
  return immediate
}
