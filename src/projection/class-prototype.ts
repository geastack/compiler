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
