import type { DeclarationId } from '../identity/ids.js'
import { runtimeClassLayoutsOf, type ClassLayout } from '../projection/classes.js'
import type { Representation } from '../representation/model.js'

export interface DynamicConstructorConversion {
  readonly role: 'construct-argument' | 'construct-result'
  readonly source: Representation
  readonly target: Representation
}

const descendsFrom = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId, base: DeclarationId): boolean => {
  const seen = new Set<DeclarationId>()
  for (let current: DeclarationId | null = declaration; current !== null && !seen.has(current);) {
    if (current === base) return true
    seen.add(current)
    current = classes.get(current)?.base ?? null
  }
  return false
}

/**
 * The conversions a `this.constructor` read renders, one candidate runtime
 * class at a time: the dispatching constructor's own frame is adapted into
 * each descendant's construct convention, and the descendant's instance back
 * into the frame's result. The emitter selects among those classes at run
 * time, so every candidate's pairs have to be certified, not only the one the
 * program happens to construct.
 */
export const dynamicConstructorConversionsOf = (
  receiver: Representation,
  result: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): readonly DynamicConstructorConversion[] => {
  if (receiver.kind !== 'class-ref' || result.kind !== 'constructor-value-dispatch') return []
  const target = result.abi
  const conversions: DynamicConstructorConversion[] = []
  for (const layout of runtimeClassLayoutsOf(classes)) {
    if (!descendsFrom(classes, layout.declaration, receiver.declaration)) continue
    const actual = layout.construct
    const instance = layout.instance
    if (actual == null || instance == null || instance.kind !== 'class-ref') continue
    actual.parameters.forEach((parameter, position) => {
      if (actual.restFrom === position) {
        const source = target.parameters[position]
        if (source !== undefined) conversions.push({ role: 'construct-argument', source: source.value, target: parameter.value })
        return
      }
      if (target.restFrom !== null && position >= target.restFrom) {
        const packed = target.parameters[target.restFrom]
        if (packed?.value.kind === 'array-object')
          conversions.push({ role: 'construct-argument', source: packed.value.element, target: parameter.value })
        return
      }
      const source = target.parameters[position]
      if (source !== undefined) conversions.push({ role: 'construct-argument', source: source.value, target: parameter.value })
    })
    conversions.push({ role: 'construct-result', source: instance, target: target.result })
  }
  return conversions
}
