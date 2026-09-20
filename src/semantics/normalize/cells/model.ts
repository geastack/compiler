import type ts from 'typescript'
import type { DeclarationId } from '../../../identity/ids.js'
import type { CollectionTypeArguments } from '../collection-bindings.js'
import type { ObjectBagShape } from '../object-bag-bindings.js'

/**
 * Replaced rather than instrumented: the six private censuses that
 * answer "what can this storage cell hold" (`parameter-bindings.ts`,
 * `return-bindings.ts`, `local-bindings.ts`, `field-bindings.ts`,
 * `collection-bindings.ts`, `object-bag-bindings.ts`) become six evidence
 * POLICIES over one shared table, keyed by domain the way every other census
 * in the registry (2.4) is keyed by the question it answers, never by its
 * position in `structural.ts`'s chain.
 */
export type CellDomain = 'parameter' | 'return' | 'local' | 'field' | 'collection' | 'bag'

/**
 * One answer language for all six domains, replacing the three the audit in
 * the value-flow survey found (`ts.Type | null`, an `ObjectBagShape`, a list of
 * union arms). Four domains (parameter, return, local, field) answer in
 * `ts.Type`-space and use only `type`; the other two keep their own richer
 * shape rather than being forced into one that cannot state a key/value pair
 * or a member map -- a census answers one question program-wide, publishes a sealed table,
 * entry and this directory's own README-shaped comment in `facts.ts` for why
 * that is a closed union rather than a fourth private shape.
 */
export type CellValue =
  | { readonly kind: 'type'; readonly type: ts.Type }
  | { readonly kind: 'collection-arguments'; readonly arguments: CollectionTypeArguments }
  | { readonly kind: 'bag-shape'; readonly shape: ObjectBagShape }

/** Wraps a `ts.Type` answer -- the language the four ported policies (parameter, return, local, field) speak. */
export const cellType = (type: ts.Type): CellValue => ({ kind: 'type', type })

/**
 * One domain's answer for one declaration, in the three primitives
 * The value-flow survey's names: `stated` (the program's own annotation),
 * `writeJoin` (what the evidence policy's admitted writes agree on), and
 * `checker` (the checker's own answer, always present as the fallback of last
 * resort). `resolved` is `stated ?? writeJoin ?? checker` -- the one join,
 * asked once, rather than a position in an ordered chain.
 */
export interface CellFacts {
  readonly domain: CellDomain
  readonly declaration: ts.Node
  readonly id: DeclarationId
  readonly stated: CellValue | null
  readonly writeJoin: CellValue | null
  readonly checker: CellValue | null
  readonly resolved: CellValue | null
}

/**
 * A declaration two domains both published `CellFacts` for -- recorded here,
 * not refused. Phase 4.2 turns each of these into a `CellRefusal` below;
 * this shape stays as the raw evidence (which domains, which id) that the
 * refusal is built from, the way `ir/certify.ts`'s `CapabilityDemand` stays
 * separate from the `Refusal` it can produce.
 */
export interface CellOwnerClaim {
  readonly id: DeclarationId
  readonly domains: readonly CellDomain[]
}

/**
 * Phase 4.2: a `CellOwnerClaim` restated in the compiler's refusal
 * vocabulary (`ir/refusal.ts`'s `Refusal`: `stage`, `key`, `reason`,
 * `owner`) rather than left as a count. Two evidence domains both claiming
 * one declaration is a census disagreement -- the honest answer names both
 * domains and the declaration, the way `field-bindings.ts` and
 * `collection-bindings.ts` disagreeing about one declaration
 * (`collection-bindings.ts:200-224`) never had a name before.
 *
 * `stage: 'cells'` and `key`'s `cell-owner:` prefix are their own namespace,
 * not a member of `ir/refusal.ts`'s `RefusalStage`/`RefusalKey` unions: a
 * cell-domain collision is decided before there is a plan to certify
 * against, and joining `CompileResult.refusals` is a later phase's call
 * (nothing reads this table yet -- see `agreement.ts`'s header on why this
 * whole publication is additive-only for now). The key embeds the domain
 * pair and the declaration's `ts.SyntaxKind` name -- `parameter.ts` and
 * `local-bindings.ts`'s own refusal-key convention
 * (`function-escapes:${ts.SyntaxKind[...]}`) -- so grouping refusals by
 * `key` is grouping by root without parsing `reason`.
 */
export type CellRefusalKey = `cell-owner:${string}`

export interface CellRefusal {
  readonly stage: 'cells'
  readonly key: CellRefusalKey
  readonly reason: string
  readonly owner: string
}

/** The published table: every fact, indexed by declaration identity, plus every collision found while indexing, typed. */
export interface CellFactsTable {
  readonly all: readonly CellFacts[]
  readonly byId: ReadonlyMap<DeclarationId, readonly CellFacts[]>
  readonly twoOwnerClaims: readonly CellOwnerClaim[]
  readonly refusals: readonly CellRefusal[]
}
