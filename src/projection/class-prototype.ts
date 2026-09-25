import type { DeclarationId } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { ClassLayout } from './classes.js'

/** Native, method-only prototype identity reads do not expose instance fields. */
export const classPrototypeReadOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  receiver: Representation,
  key: string,
  value: Representation
): ClassLayout | null => {
  if (key !== 'prototype' || receiver.kind !== 'constructor-family' || receiver.members.length !== 1 || value.kind !== 'class-ref')
    return null
  const layout = classes.get(receiver.members[0]!)
  if (
    !layout ||
    layout.instance?.kind !== 'class-ref' ||
    layout.prototypeUnsupportedUses?.length ||
    representationKey(layout.instance) !== representationKey(value)
  )
    return null
  const seen = new Set<DeclarationId>()
  for (let declaration: DeclarationId | null = layout.declaration; declaration !== null;) {
    if (seen.has(declaration)) return null
    seen.add(declaration)
    const ancestor = classes.get(declaration)
    if (!ancestor || ancestor.nativeBase !== null) return null
    declaration = ancestor.base
  }
  return layout
}

/**
 * Whether an object carried as `declaration` may inherit from a prototype the
 * program extends at run time (`ClassLayout.prototypeExtensions`): the class
 * itself or an ancestor is extended, or a descendant is, since the carrier
 * may hold a descendant's instance. Only then can a read that misses every
 * declared method find something in a prototype table.
 */
export const classPrototypeExtendedOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId): boolean => {
  const chainOf = (start: DeclarationId): DeclarationId[] => {
    const chain: DeclarationId[] = []
    for (let current: DeclarationId | null = start; current !== null && !chain.includes(current);) {
      chain.push(current)
      current = classes.get(current)?.base ?? null
    }
    return chain
  }
  for (const layout of classes.values()) {
    if (!layout.prototypeExtensions?.length) continue
    if (chainOf(declaration).includes(layout.declaration) || chainOf(layout.declaration).includes(declaration)) return true
  }
  return false
}
