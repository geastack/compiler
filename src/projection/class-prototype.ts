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
  if (!layout) return null
  // A local, not `layout.instance?.kind`: a native build does not carry that
  // narrowing to the key read below and would see an optional carrier there.
  const instance = layout.instance
  if (
    !instance ||
    instance.kind !== 'class-ref' ||
    layout.prototypeUnsupportedUses?.length ||
    representationKey(instance) !== representationKey(value)
  )
    return null
  const seen = new Set<DeclarationId>()
  for (let declaration: DeclarationId | null = layout.declaration; declaration !== null;) {
    if (seen.has(declaration)) return null
    seen.add(declaration)
    const ancestor = classes.get(declaration)
    // A native collection base holds no field the prototype object could
    // expose: its storage starts empty, exactly as every field of the
    // prototype object starts absent. An Error base carries own fields
    // (`message`, `stack`) the prototype would wrongly publish.
    if (!ancestor || (ancestor.nativeBase !== null && ancestor.nativeBase.instance.kind !== 'keyed-collection')) return null
    declaration = ancestor.base
  }
  return layout
}
