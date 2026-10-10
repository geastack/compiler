import type { DeclarationId } from '../identity/ids.js'
import { symbolPropertyKeyDeclarationOf } from '../semantics/model/structural-types.js'

/** Resolve a structural symbol key against the frontend's authenticated declarations. */
export const wellKnownSymbolMemberOfKey = (wellKnownSymbols: ReadonlyMap<DeclarationId, string>, key: string): string | null => {
  const symbol = symbolPropertyKeyDeclarationOf(key)
  if (symbol === null) return null
  for (const [declaration, member] of wellKnownSymbols) if (declaration === symbol) return member
  return null
}
