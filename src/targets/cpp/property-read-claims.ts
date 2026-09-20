import type { IrValueId } from '../../identity/ids.js'
import type { GetOperation, IrOperand } from '../../ir/model.js'
import { isNativeCallableCarrier } from './emit-dynamic-properties.js'

/**
 * Claims lifted out of `emit-properties.ts`'s `emitGet` ladder: each rung
 * below used to decide, inline, WHAT KIND of read a `get` is at the same
 * point it composed the C++ text for it. Per the single-census architecture's
 * architecture rule, a decision and its spelling are two different questions,
 * and only the second may stay at the render site.
 *
 * Every claim here is pure in already-settled facts -- `staticKeyTexts`,
 * `unreadValues`, and the IR's own carriers -- and mints nothing: no name, no
 * declaration, no buffer push, and no read of anything a printer has already
 * written (`ctx.valueNames`/`operandText`). That is what makes each one safe
 * to ask before the first line of a body renders, not only from `emitGet`
 * itself.
 */

/**
 * The named-field half of a `record-with-index` receiver's own split layout
 * (see `emit-properties.ts`'s `recordWithIndexFieldText`, the sole caller):
 * whether a `get`'s key is a *constant* text that names one of the carrier's
 * own declared `fields`, as opposed to the sidecar's open half.
 *
 * `ir/certify/property-access.ts`'s `recordWithIndexKeyNamesAField` asks the
 * identical question -- `representation.kind === 'record-with-index'` and a
 * `.fields.some/.find` against the same key text -- over the semantic
 * operand's own key/representation rather than the IR's. The two have not
 * been unified here: they live in different layers (`ir/certify/` certifies
 * a semantic operation before lowering; this asks an already-lowered `get`'s
 * settled `staticKeyTexts`) and unifying them is out of this file's scope,
 * but a caller auditing "does anything else answer this" should start there
 * rather than assume this is the only place that knows.
 */
export interface RecordWithIndexFieldClaim {
  readonly fieldKey: string
}

export const recordWithIndexFieldClaimOf = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): RecordWithIndexFieldClaim | null => {
  const representation = receiver.representation
  if (representation.kind !== 'record-with-index') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  const field = representation.fields.find((entry) => entry.key === staticKey)
  if (!field) return null
  return { fieldKey: staticKey }
}

/**
 * Whether a `get` off a native callable is a deferred read of
 * `Function.prototype.call`/`apply`/`bind` that a call downstream already
 * rewrote away -- `ir/lower-invocation.ts`'s `deferredFunctionCallCalleeOf`/
 * `deferredFunctionApplyCalleeOf`/the direct `bind` lowering into
 * `bind-callable` -- so this read itself has nothing left to spell and the
 * result the lowering left unread is the proof of it.
 *
 * `isNativeCallableCarrier` is the one authority for the carrier-kind half,
 * asked here instead of re-listing callable representation kinds a fourth
 * time -- see `emit-properties.ts`'s own comment on the drift that cost one
 * spelling of that list `function-value-family`.
 *
 * A THIRD authority answers a related but not identical question at a third
 * pipeline stage: `ir/certify/property-access-keys.ts`'s
 * `callableBuiltinResolutionAt`/`callableBuiltinRecipeKey` certifies, from the
 * semantic graph and a synthetic plan, whether a `.call`/`.apply`/`.bind`
 * property read has a renderable recipe at all; `projection/callee.ts`'s
 * `deferredCalleeOf` decides, at lowering, whether the CALL that reads this
 * `get`'s result rewrites to skip it. This claim answers neither of those --
 * it only reads the LOWERED body's own settled facts to decide whether the
 * `get` that survived lowering unread has anything left to print. Three
 * questions, three stages; not reconciled here.
 */
export type CallableBuiltinReadClaim = 'call' | 'apply' | 'bind'

export const deferredCallableBuiltinReadClaimOf = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  unreadValues: ReadonlySet<IrValueId>,
  operation: GetOperation
): CallableBuiltinReadClaim | null => {
  if (!isNativeCallableCarrier(operation.receiver.representation.kind)) return null
  if (!unreadValues.has(operation.result.id)) return null
  const key = staticKeyTexts.get(operation.key.value)
  if (key === 'call' || key === 'apply' || key === 'bind') return key
  return null
}
