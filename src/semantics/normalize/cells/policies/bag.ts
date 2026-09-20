import ts from 'typescript'
import type { ObjectBagIdentity, ObjectBagShape } from '../../object-bag-bindings.js'
import type { ValueFlowIndex, ValueWrite } from '../../flow/model.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidenceContribution, CellEvidencePolicy } from '../policy.js'
import { rulesFor } from '../policy.js'
import { joinCellTypeValues } from './shared.js'

/**
 * The BAG domain: `object-bag-bindings.ts`'s open-property-bag question,
 * restated as evidence rules over the shared flow index's
 * `property-assignment`/`index-assignment` edges, joined per MEMBER NAME
 * (`write.member`) rather than per cell -- the same
 * `CellEvidenceContribution` extension `collection.ts` introduced, applied to
 * the obstacle `policies/index.ts`'s header used to call the harder one:
 * the member-name join was never the blocker.
 *
 * What this policy does NOT do, and could not without duplicating
 * `object-bag-bindings.ts`'s own fixpoint a second time: decide which
 * declarations are the SAME bag. That is `identity`'s published answer
 * (`ObjectBagIdentity` -- `bagOf`/`returnsBag`/`conflicted`/`ungrounded`,
 * settled once by a whole-program worklist over assignments, exhaustive
 * `return`s, and one layer of callee-alias unwrapping). This policy CONSUMES
 * that settled fixpoint rather than re-deriving it: `candidatesOf` is not a
 * per-node syntactic test over `files` at all (every other domain's is) --
 * it is `identity.roots`, the set the fixpoint already found, handed to this
 * policy at construction alongside the checker.
 *
 * `writesOf` reads `identity.bagOf`'s own entries to pool one root's aliases
 * -- every declaration the fixpoint proved is the same storage -- exactly
 * the way `collection.ts`'s `writesOverAliasClosure` widens WHERE evidence is
 * gathered from, except the closure here is not walked again: it was already
 * computed, so this is a lookup into the published map rather than a second
 * BFS over `flow.flowsFromDeclaration`.
 *
 * What is left unported, matching `collection.ts`'s own posture toward its
 * gaps: `conflicted`/`ungrounded` roots are NOT excluded from `candidatesOf`
 * -- a root is a candidate here exactly as an unwritten field is still a
 * `field` candidate, and `combine` answering `null` for it (no admissible
 * evidence, or a disagreement) is the same "no override" this table gives
 * every other domain's failed candidate. Excluding them would hide a
 * genuine collision from `twoOwnerClaims` for no gain, since nothing
 * downstream reads this domain's answer yet. The `delete`/`Object.assign`/
 * spread refusal vocabulary `object-bag-bindings.ts` applies before binding a
 * shape is not restated: an opaque use simply contributes no evidence here,
 * the same "narrower, not wrong" trade `collection.ts`'s header already
 * accepts for its own left-out refusals.
 */
export const createBagCellPolicy = (checker: ts.TypeChecker, identity: ObjectBagIdentity): CellEvidencePolicy => {
  const aliasesOfRoot = new Map<ts.Node, ts.Node[]>()
  for (const [declaration, root] of identity.bagOf) {
    const bucket = aliasesOfRoot.get(root)
    if (bucket) bucket.push(declaration)
    else aliasesOfRoot.set(root, [declaration])
  }

  const writesOverIdentity = (declaration: ts.Node, flow: ValueFlowIndex): readonly ValueWrite[] => {
    const aliases = aliasesOfRoot.get(declaration) ?? [declaration]
    const writes: ValueWrite[] = []
    for (const alias of aliases) writes.push(...flow.writesToDeclaration(alias))
    return writes
  }

  const valueRule = (write: ValueWrite): CellValue | null => (write.value ? cellType(checker.getTypeAtLocation(write.value)) : null)

  return {
    domain: 'bag',
    // Not a `cellCandidatesOf` walk: the fixpoint already decided this set (see this
    // module's own header), so `files` -- every other domain's input -- is not asked.
    candidatesOf: (): readonly ts.Declaration[] => [...identity.roots].map((root) => root as ts.Declaration),
    // A root's own literal is admitted only when it declares no type of its own
    // (`object-bag-bindings.ts`'s `declaresOwnType`), so every candidate here is
    // unannotated by construction -- the same reason `local.ts`'s `statedAt` is
    // a real read that always answers `null` rather than a shortcut.
    statedAt: () => null,
    checkerAt: (declaration) => cellType(checker.getTypeAtLocation(declaration)),
    writesOf: writesOverIdentity,
    rules: rulesFor([
      ['property-assignment', valueRule],
      ['index-assignment', valueRule]
    ]),
    // Per-MEMBER-NAME join, not per-cell: `write.slot === 'member'` groups by
    // `write.member` into the bag's named members, and `write.slot === 'element'`
    // (a computed key, `flow/value-flow.ts`'s own partition) is the index sidecar --
    // exactly the two-question split `collection.ts` already makes for K/V, applied
    // to a bag's members/index instead. Either half joining to `null` (no evidence,
    // or a disagreement `joinCellTypeValues` refuses) contributes nothing to that
    // half alone, matching `object-bag-bindings.ts`'s own per-slot degradation.
    combine: (contributions: readonly CellEvidenceContribution[]): CellValue | null => {
      const named = new Map<string, CellValue[]>()
      const indexed: CellValue[] = []
      for (const contribution of contributions) {
        if (contribution.write.slot === 'member' && contribution.write.member !== null) {
          const bucket = named.get(contribution.write.member)
          if (bucket) bucket.push(contribution.value)
          else named.set(contribution.write.member, [contribution.value])
        } else if (contribution.write.slot === 'element') {
          indexed.push(contribution.value)
        }
      }
      if (named.size === 0 && indexed.length === 0) return null
      const members = new Map<string, ts.Type>()
      for (const [key, values] of named) {
        const joined = joinCellTypeValues(checker, values)
        if (joined) members.set(key, joined)
      }
      const index = indexed.length > 0 ? joinCellTypeValues(checker, indexed) : null
      if (members.size === 0 && index === null) return null
      const shape: ObjectBagShape = { members, index }
      return { kind: 'bag-shape', shape }
    }
  }
}
