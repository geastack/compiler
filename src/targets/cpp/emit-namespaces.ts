import type { DefineOwnPropertyOperation, IrBlockId, IrBody, IrOperand, IrResult, SetOperation } from '../../ir/model.js'
import type { Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'

/**
 * Every merge variable this body needs, and the writes that fill them.
 *
 * A merge is one variable written on each incoming path, so its name has to
 * exist before any predecessor renders -- including a predecessor earlier in
 * the block order than the merge itself. Minting every name up front is what
 * makes that hold without depending on block order.
 *
 * A merge that is a host namespace gets no name at all: it is a path, not a
 * value, and the merge already renders nothing at `emitBindingWrite`/every
 * consumer that asks `ctx.hostNamespaceReads` first. Which merges those are
 * used to be decided HERE, by a `seedNamespaceValues` that re-walked every
 * `binding-read`/`convert`/`phi` in the body before this function's own loop
 * ran -- a second implementation of exactly the fixed point
 * `host-namespace-reads.ts`'s `hostNamespaceReadsOf` now computes once, before
 * this body renders a line at all (invariant 5: no write during render).
 * `ctx.hostNamespaceReads` already carries every phi that walk would
 * have found -- including ones that walk could not have, since it never folded
 * in a `get`'s own path extension -- so this only has to ask it.
 */
export const mergeWritesOf = (
  ctx: EmitContext,
  body: IrBody,
  mint: (result: IrResult) => string
): ReadonlyMap<IrBlockId, readonly { readonly name: string; readonly value: IrOperand; readonly target: Representation }[]> => {
  const writes = new Map<IrBlockId, { readonly name: string; readonly value: IrOperand; readonly target: Representation }[]>()
  for (const blockId of body.blockOrder) {
    for (const operation of body.blocks.get(blockId)?.operations ?? []) {
      if (operation.kind !== 'phi') continue
      // A merge nothing reads has no name to write into (`ir/dead-values.ts`).
      if (ctx.deadValues.has(operation.result.id)) continue
      // A namespace merge is already settled -- asked, not re-derived.
      if (ctx.hostNamespaceReads.has(operation.result.id)) continue
      const name = mint(operation.result)
      for (const incoming of operation.incoming) {
        writes.set(incoming.block, [
          ...(writes.get(incoming.block) ?? []),
          { name, value: incoming.value, target: operation.result.representation }
        ])
      }
    }
  }
  return writes
}

/**
 * The host setter a resolved namespace-member store spells, plus the `path.
 * member` key it was found under. Facts only: `setter` is a spelling the
 * host's own static table already states (`HostNamespaceTable.propertySetters`),
 * never text this claim builds, so nothing here is rendered ahead of the
 * value operand the write still has to convert.
 */
export interface NamespaceMemberStoreSpelling {
  readonly key: string
  readonly setter: string
}

/**
 * `namespaceMemberStore`'s whole decision, spelled honestly as three outcomes
 * rather than collapsed into a boolean:
 *
 * - `null`: the receiver is not a host namespace path or value at all, so the
 *   caller falls through to the ordinary field-store paths unchanged.
 * - `{ kind: 'unclaimed-key' }`: the receiver IS a namespace, but the key did
 *   not come from a "constant" operation -- this emitter has no dynamic-key
 *   path onto a namespace, ever, so this is a REFUSAL, not a decline.
 * - `{ kind: 'no-setter' }`: the receiver and key both resolved, but the host
 *   states no WRITE spelling for this member -- also a refusal.
 * - `{ kind: 'resolved' }`: the write has somewhere to go.
 */
export type NamespaceMemberStoreDecision =
  | { readonly kind: 'unclaimed-key'; readonly path: string }
  | { readonly kind: 'no-setter'; readonly key: string }
  | ({ readonly kind: 'resolved' } & NamespaceMemberStoreSpelling)
  | null

/**
 * Lifted out of `namespaceMemberStore` below so the decision has exactly two
 * callers -- this claim's own prepass walk (`property-store-claims.ts`'s
 * `propertyStoreClaimsOf`), which settles it before the body renders a line,
 * and the resolver, which asks the claim to decide whether to spell a setter
 * call or refuse. The same "one implementation, two callers" shape the
 * sixteen `deferred*MethodClaim` functions already use for the get side
 * (invariant 5: no write during render).
 *
 * Every input -- `ctx.hostNamespaceReads`, `ctx.hostNamespaceValues`,
 * `ctx.staticKeyTexts`, `ctx.hosts.namespaces` -- is settled before this
 * body renders a line (`host-namespace-reads.ts`'s `hostNamespaceReadsOf`
 * runs in `emit.ts`'s prepass, and `hosts` is a plain, whole-program table),
 * so this is a pure function of `ctx` and `operation`: calling it twice is
 * asking the same authority twice, not building a second one.
 */
export const namespaceMemberStoreClaim = (
  ctx: EmitContext,
  operation: SetOperation | DefineOwnPropertyOperation
): NamespaceMemberStoreDecision => {
  const path = ctx.hostNamespaceReads.get(operation.receiver.value) ?? ctx.hostNamespaceValues.get(operation.receiver.value)
  if (path === undefined) return null
  // Whether this key names a static namespace member is a claim, not a fold:
  // ask `staticKeyTexts` so a value `constantTexts` only later accumulates
  // (a render-time `typeof` fold) can never make a computed key look static.
  const member = ctx.staticKeyTexts.get(operation.key.value)
  if (member === undefined) return { kind: 'unclaimed-key', path }
  const key = `${path}.${member}`
  const setter = ctx.hosts.namespaces.propertySetters.get(key)
  if (setter === undefined) return { kind: 'no-setter', key }
  return { kind: 'resolved', key, setter }
}

/**
 * A property WRITE through a host NAMESPACE -- the write-side twin of
 * `emit-properties.ts`'s own `namespaceMemberText`: a namespace receiver
 * publishes no value (nothing is materialized for `Display`, only a path), so
 * every ordinary field-store branch -- each of which eventually calls
 * `operandText` on the receiver -- would ask for a name that was never minted
 * and hit `operandText`'s "host namespace used as a value" refusal.
 * `Display.autoRotate = true` hit exactly that: `emitGet` has this same check,
 * `emitFieldStore` had none at all.
 *
 * The host states a namespace property's WRITE spelling separately from its
 * READ spelling (`Display.autoRotate` reads `gea::host::Display.autoRotate()`,
 * writes `gea::host::Display.setAutoRotate(...)`), which is why
 * `HostNamespaceTable` carries its own `propertySetters` map rather than
 * reusing `properties`.
 *
 * Returns `false` when the receiver is not a namespace at all, so the caller
 * (`emitFieldStore`) falls through to the ordinary field-store paths
 * unchanged. Decides nothing itself any more -- `namespaceMemberStoreClaim`
 * above is the one authority; this only spells whichever of its three
 * outcomes came back.
 */
export const namespaceMemberStore = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const claim = namespaceMemberStoreClaim(ctx, operation)
  if (claim === null) return false
  if (claim.kind === 'unclaimed-key') {
    // A namespace receiver has no `Representation` (only a path), so the
    // receiver half of the key names the family's own subject rather than
    // `representationKey`.
    throw createCppEmitBlockedError(
      'property-access:host-namespace:set:true',
      `a write to a member of the host namespace "${claim.path}" has a key that was not produced by a "constant" operation; this emitter has no dynamic-key path`
    )
  }
  if (claim.kind === 'no-setter') {
    throw createCppEmitBlockedError(
      `host-invocation:${claim.key}`,
      `"${claim.key}" is not a namespace property this host states a WRITE spelling for; the namespace is reachable and no setter is claimed for this member`
    )
  }
  lines.push(`${claim.setter}(${operandText(ctx, operation.value)});`)
  // A `set`'s own `IrResult` is minted with the RECEIVER's type, not the
  // stored value's -- `properties.ts`'s producer states this outright:
  // "a store's result is the receiver it wrote into, threaded onward ... the
  // enclosing expression's own value ... is published by the computation
  // that owns the assignment, not by this." That result exists for a
  // consumer that reads "the object after the write" (a struct/array/record
  // store threads `operandText(ctx, operation.receiver)` there), and it is
  // minted unconditionally -- for EVERY `set`, on ANY receiver whose checker
  // type is not itself void, whether or not anything downstream actually
  // reads it. A namespace receiver has no such object: `Display` is a path,
  // not a value, so there is nothing honest this could thread. Rather than
  // manufacture one -- a default-null carrier of the receiver's structural
  // type silently stands in for "Display" if anything reads it, which is a
  // wrong-value risk this backend does not take elsewhere -- this leaves
  // `operation.result` unminted. The one call in the whole corpus that
  // reaches here (`Display.autoRotate = true;`, a bare statement) never
  // reads it, so nothing is lost; a program that DID read it would hit
  // `nameOfValue`'s "read before it is defined" error at the read site
  // instead of silently compiling a wrong value -- fail closed, not quiet.
  return true
}
