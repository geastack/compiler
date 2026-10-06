import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from './classes.js'
import type { RecordLayoutView } from './fields.js'

/**
 * Index hooks are a capability of a physical class family, not of every
 * object. A base must declare the hooks when a descendant owns index storage:
 * reflection through a base handle must dispatch to the descendant. Siblings
 * keep the same protocol so inherited virtual calls remain well formed.
 * Missing layouts and external ancestry retain support rather than proving
 * absence from incomplete evidence.
 */
export const classIndexProtocolsOf = (
  classes: ReadonlyMap<DeclarationId, Pick<ClassLayout, 'instance' | 'base' | 'nativeBase'>>,
  layoutOf: (shapeId: string) => RecordLayoutView | null
): ReadonlyMap<DeclarationId, boolean> => {
  const neighbors = new Map<DeclarationId, Set<DeclarationId>>()
  const demanded = new Set<DeclarationId>()
  for (const [declaration, layout] of classes) {
    const own = layout.instance?.kind === 'class-ref' ? layoutOf(layout.instance.shapeId) : null
    if (own === null || own.indexes.length > 0 || layout.nativeBase !== null) demanded.add(declaration)
    const adjacent = neighbors.get(declaration) ?? new Set<DeclarationId>()
    neighbors.set(declaration, adjacent)
    if (layout.base === null) continue
    if (!classes.has(layout.base)) {
      demanded.add(declaration)
      continue
    }
    adjacent.add(layout.base)
    const inherited = neighbors.get(layout.base) ?? new Set<DeclarationId>()
    inherited.add(declaration)
    neighbors.set(layout.base, inherited)
  }

  const pending = [...demanded]
  for (let cursor = 0; cursor < pending.length; cursor++) {
    for (const adjacent of neighbors.get(pending[cursor]!) ?? []) {
      if (demanded.has(adjacent)) continue
      demanded.add(adjacent)
      pending.push(adjacent)
    }
  }
  return new Map([...classes.keys()].map((declaration) => [declaration, demanded.has(declaration)]))
}
