import type ts from 'typescript'
import type { FlowEdgeKind, ValueFlowIndex, ValueWrite } from '../flow/model.js'
import type { CellDomain, CellValue } from './model.js'

/**
 * One domain's reading of one write: the value it contributes to the cell's
 * write-join, or `null` to sit out. `null` is the ordinary answer for an edge
 * that exists but states no fresh value for THIS domain -- a `compound-
 * assignment` (existence only, per `flow/model.ts`'s own doc on the kind) or
 * a write whose value this domain cannot resolve to anything usable.
 */
export type CellEvidenceRule = (write: ValueWrite, declaration: ts.Node) => CellValue | null

/**
 * One admitted write, paired with the value its rule produced -- what
 * `combine` actually receives. Plain `CellValue`s were enough while every
 * ported domain (parameter, return, local, field) joined its whole cell into
 * ONE answer; `collection`/`bag` join per SLOT (`collection-key` vs
 * `collection-value`) or per MEMBER NAME (`ValueWrite.member`), a question
 * `combine` cannot ask once the write that produced a value is discarded.
 * Keeping the pair is the whole extension `policies/index.ts`'s header calls
 * for -- `combine` was already free to look at `write.slot`/`write.member`
 * (both were already on `ValueWrite`, see `flow/model.ts`), it simply never
 * received the write to look at.
 */
export interface CellEvidenceContribution {
  readonly write: ValueWrite
  readonly value: CellValue
}

/**
 * A census, restated as data: `(domain, FlowEdgeKind) -> evidence rule`,
 * the "cell census" row: a capability is keyed rows, never an ordered chain. Nothing here
 * is ordered -- a policy is asked about every edge kind it registered a rule
 * for, independent of every other policy and of any position in a chain.
 */
export interface CellEvidencePolicy {
  readonly domain: CellDomain
  /** Every declaration this domain is willing to answer for, in this program. */
  readonly candidatesOf: (files: readonly ts.SourceFile[]) => Iterable<ts.Declaration>
  /** The program's own annotation for this declaration, or `null` when it stated none. */
  readonly statedAt: (declaration: ts.Node) => CellValue | null
  /** The checker's own answer -- always present, the fallback of last resort. */
  readonly checkerAt: (declaration: ts.Node) => CellValue | null
  /**
   * The writes this domain admits as evidence for one candidate. Defaults to
   * `flow.writesToDeclaration(declaration)` (every ported `ts.Type`-space
   * domain relies on that default and states no `writesOf` of its own) --
   * `collection`'s own reason to override it is the OTHER stated obstacle:
   * `collection-bindings.ts` follows a value's identity through an ALIAS
   * CLOSURE (`const helper = []; fill(helper)`, `this.cache.set(...)`) that a
   * single declaration's own writes cannot state, because the evidence lands
   * on a DIFFERENT declaration (a parameter the value was passed to, a
   * property that re-exports it) than the candidate this policy is answering
   * for. A policy that needs that closure computes it itself, over the same
   * `flow.flowsFromDeclaration` reverse edge `collection-bindings.ts` already
   * walks -- this hook is what lets it do so without forcing every OTHER
   * domain to pay for a closure it never needed.
   */
  readonly writesOf?: (declaration: ts.Node, flow: ValueFlowIndex) => readonly ValueWrite[]
  /** One evidence rule per `FlowEdgeKind` this domain admits as a write; an edge with no entry contributes nothing. */
  readonly rules: Partial<Readonly<Record<FlowEdgeKind, CellEvidenceRule>>>
  /** The join over every admitted write, or `null` when they disagree -- never merged into a wider guess. */
  readonly combine: (contributions: readonly CellEvidenceContribution[]) => CellValue | null
}

/**
 * Builds a policy's `rules` table from `(edge, rule)` pairs and throws on a
 * second rule for one edge -- the mechanical form of table 2.8's collision
 * rule for a cell census: "a second rule for one key throws at census
 * construction." A plain object literal cannot enforce this on its own (a
 * repeated key just silently overwrites the first), so every policy in this
 * directory builds its `rules` through this function rather than writing the
 * object literal by hand.
 */
export const rulesFor = (
  entries: readonly (readonly [FlowEdgeKind, CellEvidenceRule])[]
): Partial<Readonly<Record<FlowEdgeKind, CellEvidenceRule>>> => {
  const rules: Partial<Record<FlowEdgeKind, CellEvidenceRule>> = {}
  for (const [edge, rule] of entries) {
    if (rules[edge] !== undefined) throw new Error(`cell evidence policy: two rules registered for edge kind '${edge}'`)
    rules[edge] = rule
  }
  return rules
}
