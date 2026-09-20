import ts from 'typescript'
import type { DeclarationId } from '../../../identity/ids.js'
import type { IdentityTable } from '../identities.js'
import type { ValueFlowIndex } from '../flow/model.js'
import type { CellDomain, CellFacts, CellFactsTable, CellOwnerClaim, CellRefusal } from './model.js'
import type { CellEvidenceContribution } from './policy.js'
import type { CellPolicyRegistry } from './registry.js'

/**
 * The engine every evidence policy runs through: for each candidate
 * declaration, read the shared flow index's writes to it, let the policy's
 * per-edge rules decide which ones are evidence, join what is admitted, and
 * resolve `stated ?? writeJoin ?? checker` -- the one join
 * the single-census frontend asks for, computed once here instead
 * of once per domain.
 *
 * This function is the whole of what used to be six private compositions. A
 * policy states WHAT counts as evidence and how to join it; this states HOW
 * a cell's three primitives combine into one answer, and it is the only place
 * that does.
 */
export const buildCellFactsTable = (
  identities: IdentityTable,
  flow: ValueFlowIndex,
  files: readonly ts.SourceFile[],
  registry: CellPolicyRegistry
): CellFactsTable => {
  const all: CellFacts[] = []
  const byId = new Map<DeclarationId, CellFacts[]>()

  for (const policy of registry.policies) {
    for (const declaration of policy.candidatesOf(files)) {
      const writes = policy.writesOf ? policy.writesOf(declaration, flow) : flow.writesToDeclaration(declaration)
      const admitted: CellEvidenceContribution[] = []
      for (const write of writes) {
        const rule = policy.rules[write.edge]
        if (!rule) continue
        const value = rule(write, declaration)
        if (value !== null) admitted.push({ write, value })
      }
      const writeJoin = admitted.length > 0 ? policy.combine(admitted) : null
      const stated = policy.statedAt(declaration)
      const checkerValue = policy.checkerAt(declaration)
      const resolved = stated ?? writeJoin ?? checkerValue
      // A declaration this program's identity table refuses (an uninstantiated
      // generic's own body, walked by nothing) is not a cell any consumer can
      // NAME either -- `identities.ts` is the one authority on that, and a cell
      // census asking it a second time would be exactly the two-authorities
      // defect this table exists to end.
      let id: DeclarationId
      try {
        id = identities.declarationIdOf(declaration)
      } catch {
        continue
      }
      const facts: CellFacts = { domain: policy.domain, declaration, id, stated, writeJoin, checker: checkerValue, resolved }
      all.push(facts)
      const bucket = byId.get(id)
      if (bucket) bucket.push(facts)
      else byId.set(id, [facts])
    }
  }

  const twoOwnerClaims: CellOwnerClaim[] = []
  const refusals: CellRefusal[] = []
  for (const [id, facts] of byId) {
    const domains = [...new Set(facts.map((fact) => fact.domain))]
    if (domains.length <= 1) continue
    twoOwnerClaims.push({ id, domains })
    refusals.push(cellOwnerRefusal(id, domains, facts))
  }

  return { all, byId, twoOwnerClaims, refusals }
}

/**
 * Builds the typed refusal for one collision. `facts` all share `id`, and
 * `identities.declarationIdOf` names one declaration node -- every entry's
 * `declaration` is the same node, so the first is as good as any for the
 * `SyntaxKind`/location the reason and key report.
 */
const cellOwnerRefusal = (id: DeclarationId, domains: readonly CellDomain[], facts: readonly CellFacts[]): CellRefusal => {
  const sortedDomains = [...domains].sort()
  const [first] = facts
  const declaration = first ? first.declaration : null
  const kindName = declaration ? ts.SyntaxKind[declaration.kind] : 'unknown'
  const where = declaration
    ? (() => {
        const sourceFile = declaration.getSourceFile()
        const { line } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile))
        return `${sourceFile.fileName}:${line + 1}`
      })()
    : String(id)
  return {
    stage: 'cells',
    key: `cell-owner:${sortedDomains.join('+')}:${kindName}`,
    reason: `${kindName} at ${where} is claimed by ${sortedDomains.length} cell-evidence domains (${sortedDomains.join(', ')}); a two-owner claim is a census disagreement, not a precedence question`,
    owner: String(id)
  }
}
