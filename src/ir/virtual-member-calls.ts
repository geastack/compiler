import type { IrValueId } from '../identity/ids.js'
import { virtualDispatchKey, type VirtualMemberCalls } from '../projection/dispatch.js'
import type { Representation } from '../representation/model.js'
import { allOperationsOf, type CallOperation, type GetOperation, type IrBody } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * The argument lists every call through a class member's read hands it, for
 * `projection/dispatch.ts`'s family slot: whether a position past the root's
 * formals is ever passed is what decides if the slot must carry it.
 *
 * The reads counted are exactly the ones `targets/cpp/direct-call-receivers.ts`'s
 * `virtualCalleesOf` dispatches through the object -- a read consumed only as
 * the callee of an immediate call. A method value returned, stored or passed
 * is selected when it is read and is called through its own body's convention,
 * never the slot's, so it adds nothing here. The key is any constant the read
 * names, as `IrBodyFacts.staticKeyTexts` takes it.
 */
export const virtualMemberCallsOf = (bodies: Iterable<IrBody>): VirtualMemberCalls => {
  const calls = new Map<string, (readonly Representation[])[] | null>()
  for (const body of bodies) {
    const keys = new Map<IrValueId, string>()
    const reads: GetOperation[] = []
    const callsByCallee = new Map<IrValueId, CallOperation[]>()
    const escaped = new Set<IrValueId>()
    for (const block of body.blocks.values()) {
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'constant') keys.set(operation.result.id, operation.text)
        else if (operation.kind === 'get') reads.push(operation)
        else if (operation.kind === 'call') {
          const list = callsByCallee.get(operation.callee.value) ?? []
          list.push(operation)
          callsByCallee.set(operation.callee.value, list)
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
    for (const read of reads) {
      const key = keys.get(read.key.value)
      const consumers = callsByCallee.get(read.result.id)
      if (key === undefined || consumers === undefined || escaped.has(read.result.id) || read.receiver.representation.kind !== 'class-ref')
        continue
      const slot = virtualDispatchKey(read.receiver.representation.declaration, key, 'call')
      for (const call of consumers) {
        const known = calls.get(slot)
        if (known === null) break
        // A spread hands the member however many arguments the array holds.
        if (call.argumentsAreSpread === true) {
          calls.set(slot, null)
          break
        }
        const passed = call.arguments.map((argument) => argument.representation)
        if (known === undefined) calls.set(slot, [passed])
        else known.push(passed)
      }
    }
  }
  return calls
}

/**
 * Whether two readings agree on how many arguments every call through every
 * member passes -- the part of the fact a slot's length is decided from.
 *
 * The verdict is taken before the last IR passes run and again when the unit
 * renders, from the fact read the first time. A pass between them that added a
 * call through a member, or changed what one passes, would leave the slot
 * shorter than a call the unit prints; reading the printed bodies again and
 * comparing is what keeps that a refusal rather than a dropped argument.
 */
export const virtualMemberCallsAgree = (left: VirtualMemberCalls, right: VirtualMemberCalls): boolean => {
  const profile = (calls: VirtualMemberCalls): string =>
    [...calls]
      .map(
        ([key, entry]) =>
          `${key}=${
            entry === null
              ? '*'
              : entry
                  .map((call) => call.length)
                  .sort((a, b) => a - b)
                  .join(',')
          }`
      )
      .sort()
      .join(';')
  return profile(left) === profile(right)
}
