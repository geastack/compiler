import type { IrOperand } from '../../../ir/model.js'
import type { IrValueId } from '../../../identity/ids.js'
import type { EmitContext, PrototypeMethodRead } from '../emit-context.js'
import { createCppEmitBlockedError } from '../emit-context.js'
import { isNativeError } from '../error-types.js'
import { representationKey } from '../../../representation/model.js'

/**
 * `Error.prototype.toString` (ECMA-262 20.5.3.4), the one member of that
 * prototype this backend renders.
 *
 * Every other property an Error exposes -- `name`, `message`, `stack`,
 * `cause` -- is a DATA property of the instance, which the native layout
 * already declares and the ordinary field path already reads. `toString` is
 * the only one that is a method, and the algorithm is small and closed: the
 * name alone when the message is empty, the message alone when the name is,
 * and `"<name>: <message>"` otherwise. `gea::runtime::Error::toString` is
 * that algorithm, already written and already used by `toStringText` for
 * `${e}` and `String(e)` -- so this is not a second implementation of it, it
 * is the EXPLICIT spelling reaching the same member the implicit ones do.
 *
 * Without this claim the read fell all the way to the dynamic-property
 * sidecar, where `toString` is one of `Array.prototype`'s own member names
 * and the refusal came out as "Array.prototype.toString has no rendering off
 * a native-record-ref(gea::runtime::Error) receiver" -- a true statement about
 * the wrong prototype, because the ladder had no Error rung at all.
 */
const errorPrototypeMethods: ReadonlySet<string> = new Set<string>(['toString'])

export const deferredNativeErrorMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  if (!isNativeError(receiver.representation)) return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !errorPrototypeMethods.has(staticKey)) return null
  return { receiverKind: 'native-error', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

/**
 * The read half: an Error's `toString` produces no C++ of its own and fuses
 * with the call that follows, exactly as a Date's or a string's method read
 * does. A claimed read that publishes no value has no call to fuse WITH, so
 * it refuses by name rather than rendering nothing into a cell nobody wrote.
 */
export const nativeErrorMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrValueId | null): string | null => {
  const claim = deferredNativeErrorMethodClaim(ctx.staticKeyTexts, receiver, key)
  if (claim === null) return null
  if (result === null) {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver.representation)}:get:false`,
      `"${claim.member}" is an Error.prototype method, and this access publishes no value for its call to consume`
    )
  }
  return ''
}

/** The call half, fused with the read above. */
export const nativeErrorCallText = (member: string, receiverText: string): string => {
  if (member !== 'toString') {
    throw createCppEmitBlockedError(
      `host-invocation:Error.prototype.${member}`,
      `"Error.prototype.${member}" was recorded as a deferred Error method read, and no renderer here states it`
    )
  }
  return `${receiverText}->toString()`
}
