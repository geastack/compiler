import type { DeclarationId } from '../identity/ids.js'
import { symbolPropertyKeyDeclarationOf } from '../semantics/model/structural-types.js'
import type { ClassLayout } from './classes.js'

/** A member installed on the native class prototype or an inherited prototype.
 * This proves presence only. Missing names still require runtime lookup.
 */
export const classPrototypeMemberIsPresent = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): boolean => {
  const seen = new Set<DeclarationId>()
  let current: DeclarationId | null = declaration
  while (current && !seen.has(current)) {
    seen.add(current)
    const layout = classes.get(current)
    if (!layout) return false
    if (
      layout.methods.some((method) => method.key === key && method.callable !== null) ||
      layout.accessors.some((accessor) => accessor.key === key && (accessor.getter !== null || accessor.setter !== null))
    )
      return true
    current = layout.base
  }
  return false
}

/**
 * Whether a SYMBOL key could name a member this carrier's own layout declares
 * -- a symbol-keyed field, accessor or prototype method, on the shape itself or
 * anywhere up a class's base chain.
 *
 * It exists so `k in o` can be answered for a key that is a symbol VALUE rather
 * than a name the program spelled. A compiler-owned object with shared identity
 * carries a dynamic-property sidecar that answers own-key membership for any
 * runtime key, symbols included, and a symbol cannot reach an inherited
 * STRING-named member the way an arbitrary string can -- the two key spaces are
 * physically disjoint here (`types.ts`'s `sym(<declaration>)` marker). So when
 * this answers `false`, the sidecar is not merely one source of the answer: it
 * is the WHOLE answer, and `in` over that receiver is exactly its verdict.
 *
 * When it answers `true`, the layout owns a symbol-keyed slot with its own
 * presence bit that the sidecar knows nothing about, and which of the two holds
 * the key is undecidable without knowing WHICH symbol -- so the site refuses by
 * name instead, rather than consulting one half and calling it the answer.
 */
export const symbolKeyedMemberIsDeclared = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  fields: readonly { readonly key: string }[] | null,
  declaration: DeclarationId | null
): boolean => {
  const isSymbolKey = (entry: { readonly key: string }): boolean => symbolPropertyKeyDeclarationOf(entry.key) !== null
  if (fields !== null && fields.some(isSymbolKey)) return true
  const seen = new Set<DeclarationId>()
  let current: DeclarationId | null = declaration
  while (current && !seen.has(current)) {
    seen.add(current)
    const layout: ClassLayout | undefined = classes.get(current)
    if (!layout) return true
    if (
      layout.fields.some(isSymbolKey) ||
      layout.methods.some(isSymbolKey) ||
      layout.accessors.some(isSymbolKey) ||
      (layout.methodOverrides ?? []).some(isSymbolKey)
    )
      return true
    current = layout.base
  }
  return false
}
