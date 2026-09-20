import type { CellDomain } from './model.js'
import type { CellEvidencePolicy } from './policy.js'

/** Every domain's evidence policy, registered once. */
export interface CellPolicyRegistry {
  readonly policies: readonly CellEvidencePolicy[]
}

/**
 * Registers one evidence policy per domain -- table 2.8's collision rule for
 * a cell census, on the other axis `policy.ts`'s `rulesFor` does not cover:
 * two policies both claiming one domain, rather than two rules inside one
 * policy. Thrown at construction, not discovered later as two domains quietly
 * shadowing each other the way `structural.ts`'s `typeAt` chain lets a
 * position decide today.
 */
export const createCellPolicyRegistry = (policies: readonly CellEvidencePolicy[]): CellPolicyRegistry => {
  const seen = new Set<CellDomain>()
  for (const policy of policies) {
    if (seen.has(policy.domain)) throw new Error(`cell evidence policy: domain '${policy.domain}' registered twice`)
    seen.add(policy.domain)
  }
  return { policies }
}
