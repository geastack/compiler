import type { IrBody } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import type { IrValueId } from '../../identity/ids.js'
import type { EmitContext } from './emit-context.js'
import { namespaceMemberStoreClaim, type NamespaceMemberStoreSpelling } from './emit-namespaces.js'
import { regexpDynamicSetClaim, type RegExpDynamicSetClaim } from './prototype/emit-prototype-regexp.js'

/**
 * Every store-side property claim in one body, settled before it renders a
 * line -- the write counterpart of `prototype/prototype-method-reads.ts`'s
 * `prototypeMethodReadsOf`. `emit-properties.ts`'s store ladder
 * (`emitFieldStore` -> `emitFieldStoreLines`) has around a dozen rungs; this
 * walk covers the two whose whole decision is a pure function of settled
 * facts (invariant 5: no write during render): `namespaceMemberStore`
 * and `emitRegExpSet`. The rest stay render-time resolvers for now, exactly
 * as the get-side migration moved one carrier at a time.
 *
 * Both claims below are called TWICE by design: once here, to settle the
 * fact before any line of the body prints, and once by the resolver that
 * spells it. A claim being pure -- it takes only `ctx` and the operation, and
 * reads nothing a printer has written -- is what makes calling it twice free
 * of the two-authorities defect this refactor exists to remove: there is one
 * decision, asked twice, not two decisions that happen to agree today. The
 * same shape the sixteen `deferred*MethodClaim` functions already use for the
 * get side.
 *
 * `regexpStoreRefusal` (`prototype/emit-prototype-regexp.ts`'s third rung) is
 * deliberately NOT walked here, even though its own decision was extracted
 * into a claim (`regexpStoreRefusalClaim`) the same way. Its only outcomes
 * past "not a RegExp" are "declines silently" (lastIndex, a genuine expando)
 * and "refuses" -- and a refusal is not a fact anything downstream reads: it
 * has no C++ to schedule and no value id to key a census by. Recording it
 * here would mean either throwing from this walk -- which would report
 * whichever refusal this store-only walk reaches first, rather than whichever
 * operation of ANY kind actually renders first in the body, a reordering the
 * refactor's own byte-identical gate cannot see (it counts refusals per
 * program, not which one fires when several are present) -- or keeping a map
 * nothing consults. Both are worse than leaving it a resolver-only decision
 * until a genuine downstream reader shows up to justify one.
 */
export interface PropertyStoreClaims {
  /**
   * Every `set`/`define-own-property` this body resolves as a write through a
   * host namespace, keyed by the store's own result id. See
   * `EmitContext.namespaceMemberStores` for why that id is worth recording at
   * all: a namespace receiver publishes no value, so `namespaceMemberStore`
   * never mints this result -- a value id appearing here is exactly a value
   * id that will never reach `defineValue`, the same kind of fact
   * `hostNamespaceReads`/`hostNamespaceValues` already state for a namespace
   * READ.
   */
  readonly namespaceMemberStores: ReadonlyMap<IrValueId, NamespaceMemberStoreSpelling>
  /**
   * Every `set` this body resolves as a dynamic write into a RegExp Pattern's
   * identity-keyed sidecar (a computed key, or a named expando that is not
   * one of the ten `RegExp.prototype` members), keyed by the store's own
   * result id -- unlike the namespace map above, this result IS minted
   * (`emitRegExpSet` threads the receiver through `defineValue` once the
   * dynamic write renders), so this map's fact is "this store's own decision
   * is dynamic", not "this value id will never be defined".
   */
  readonly regexpDynamicSets: ReadonlyMap<IrValueId, RegExpDynamicSetClaim>
}

export const propertyStoreClaimsOf = (ctx: EmitContext, body: IrBody): PropertyStoreClaims => {
  const namespaceMemberStores = new Map<IrValueId, NamespaceMemberStoreSpelling>()
  const regexpDynamicSets = new Map<IrValueId, RegExpDynamicSetClaim>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'set' && operation.kind !== 'define-own-property') continue
      // Neither claim below has anything to key a census entry by when this
      // particular store publishes no result -- and nothing outside this
      // walk could look one up by a value id that was never minted either.
      if (operation.result === null) continue
      const namespaceClaim = namespaceMemberStoreClaim(ctx, operation)
      if (namespaceClaim !== null && namespaceClaim.kind === 'resolved') {
        namespaceMemberStores.set(operation.result.id, { key: namespaceClaim.key, setter: namespaceClaim.setter })
      }
      const regexpClaim = regexpDynamicSetClaim(ctx, operation)
      if (regexpClaim !== null) regexpDynamicSets.set(operation.result.id, regexpClaim)
    }
  }
  return { namespaceMemberStores, regexpDynamicSets }
}
