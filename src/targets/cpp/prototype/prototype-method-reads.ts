import type { GetOperation, IrBody, IrOperand } from '../../../ir/model.js'
import { allOperationsOf } from '../../../ir/model.js'
import type { IrValueId } from '../../../identity/ids.js'
import type { EmitContext, PrototypeMethodRead } from '../emit-context.js'
import {
  deferredArrayMethodClaim,
  deferredDictionaryMethodClaim,
  deferredIteratorMethodClaim,
  deferredKeyedCollectionMethodClaim,
  deferredPromiseMethodClaim,
  deferredScalarMethodClaim,
  deferredStringMethodClaim,
  deferredTypedArrayMethodClaim
} from '../emit-carrier-members.js'
import { deferredDataViewMethodClaim } from '../emit-buffers.js'
import { deferredTypedArrayUnionMethodClaim, deferredUnionToStringClaim } from '../emit-union-properties.js'
import { mixedPrototypeCallArmsOf } from '../../../projection/native-prototype-methods.js'

import { deferredCallableShapeMethodClaim } from '../emit-dynamic-properties.js'
import { deferredDynamicObjectMethodClaim, deferredObjectShapeMethodClaim } from '../host/object-protocol.js'
import { deferredIntrinsicReflectionClaim } from '../host/emit-host-properties.js'
import { deferredDateMethodClaim } from './emit-prototype-date.js'
import { deferredNativeErrorMethodClaim } from './emit-prototype-error.js'
import { deferredRegexpMethodClaim } from './emit-prototype-regexp.js'

/**
 * Every deferred prototype-method read in one body, settled before the body
 * renders a line.
 *
 * This composes; it decides nothing. Each carrier's own resolver already IS
 * the authority for what a deferred read on that carrier is, so the claim was
 * lifted out of the resolver as a function and there are exactly two callers
 * of it: this walk, which records the fact, and the resolver, which spells the
 * answer. Nothing here re-tests a predicate that lives in a resolver, and a
 * new carrier is reachable only by adding its claim to both ends -- which is
 * the whole point (invariant 5: no write during render).
 *
 * The order is `emitGet`'s own ladder order, so a receiver two claims could
 * both answer resolves the way the printer resolves it. The claims are keyed
 * on disjoint carrier kinds almost everywhere; where they are not -- the four
 * `Object.prototype` reflection claims -- the ladder is what separates them.
 *
 * `hostMemberReads` is asked first because `declaredHostMethodRead` preempts
 * every branch below it: a read the host tables already claimed is a host
 * member, never a prototype method.
 */
export const prototypeMethodReadsOf = (ctx: EmitContext, body: IrBody): ReadonlyMap<IrValueId, PrototypeMethodRead> => {
  const reads = new Map<IrValueId, PrototypeMethodRead>()
  // `emitGet` re-enters itself with the proven-present view of an optional
  // receiver, so that view -- not the optional -- is the operand every claim
  // below sees at render time. `unwrapPresentValue` is the render-side twin of
  // this line; it additionally MINTS the unwrap, which is a spelling, not a
  // fact.
  const presentView = (receiver: IrOperand): IrOperand =>
    receiver.representation.kind === 'optional'
      ? { value: `${receiver.value}:present` as IrValueId, representation: receiver.representation.payload }
      : receiver
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get') continue
      if (ctx.hostMemberReads.has(operation.result.id)) continue
      const receiver = presentView(operation.receiver)
      const claim = claimOf(ctx, receiver, operation) ?? mixedUnionClaimOf(ctx, receiver, operation)
      if (claim !== null) reads.set(operation.result.id, claim)
    }
  }
  return reads
}

/** The ladder itself, over one receiver operand -- asked of a whole value and, by `mixedUnionClaimOf`, of one arm of one. */
const claimOf = (ctx: EmitContext, receiver: IrOperand, operation: GetOperation): PrototypeMethodRead | null => {
  const key = operation.key
  const texts = ctx.staticKeyTexts
  return (
    deferredTypedArrayUnionMethodClaim(texts, receiver, key) ??
    deferredUnionToStringClaim(ctx, receiver, key) ??
    deferredArrayMethodClaim(texts, receiver, key) ??
    deferredTypedArrayMethodClaim(texts, receiver, key) ??
    deferredDataViewMethodClaim(texts, receiver, key) ??
    deferredStringMethodClaim(texts, receiver, key) ??
    deferredScalarMethodClaim(texts, receiver, key) ??
    deferredRegexpMethodClaim(texts, receiver, key) ??
    deferredPromiseMethodClaim(texts, receiver, key) ??
    deferredIteratorMethodClaim(texts, receiver, key) ??
    deferredKeyedCollectionMethodClaim(texts, receiver, key) ??
    deferredDateMethodClaim(texts, receiver, key) ??
    deferredNativeErrorMethodClaim(texts, receiver, key) ??
    deferredIntrinsicReflectionClaim(ctx.hosts, texts, receiver, key) ??
    deferredDictionaryMethodClaim(texts, receiver, key) ??
    deferredObjectShapeMethodClaim(ctx, { ...operation, receiver }) ??
    deferredCallableShapeMethodClaim(texts, receiver, key) ??
    deferredDynamicObjectMethodClaim(texts, receiver, key)
  )
}

/**
 * A prototype-method read off a HETEROGENEOUS tagged union.
 *
 * `deferredTypedArrayUnionMethodClaim` above claims a union whose every arm
 * means the same thing by the member. This claims the other kind:
 * `(query(t, k) as string[]).join` reads `join` off `string | string[] |
 * Record<string, string> | Record<string, string[]>`, where exactly one arm
 * has an `Array.prototype.join` and the rest have nothing callable of that
 * name at all. Each arm that answers keeps its OWN recorded read -- asked of
 * the same ladder, so no arm is answered by a second copy of a rule -- and the
 * arms that cannot answer are recorded as `null`.
 *
 * `null` is admitted only where the arm PROVABLY has no callable member of
 * that name (`armHasNoCallableMember`), never merely because this backend
 * renders nothing for it: the difference between "the language answers
 * undefined here" and "this member is not implemented yet" is the difference
 * between the TypeError JavaScript throws and a wrong answer, so an arm this
 * cannot prove refuses the whole claim and the read keeps its named refusal.
 *
 * Claimed only at a call fusion, which is what makes the throw exact: a read
 * that is not called can observe the `undefined`, and this claim is consulted
 * only through `prototypeMethodCallText`.
 */
const mixedUnionClaimOf = (ctx: EmitContext, receiver: IrOperand, operation: GetOperation): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'tagged-union') return null
  const member = ctx.staticKeyTexts.get(operation.key.value)
  if (member === undefined) return null
  const arms = mixedPrototypeCallArmsOf(carrier, member, (arm) => claimOf(ctx, { value: receiver.value, representation: arm }, operation))
  if (arms === null) return null
  return {
    receiverKind: 'mixed-union',
    member,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: null,
    mixedUnionCarrier: carrier,
    mixedUnionArms: arms
  }
}
