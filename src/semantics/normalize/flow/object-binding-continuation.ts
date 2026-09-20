import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'

export interface ObjectBindingRead {
  readonly key: string
  readonly binding: ts.BindingElement
}

const reads = new WeakMap<ValueFlowIndex, ReadonlyMap<ts.Expression, ReadonlyMap<ts.BindingElement, string>>>()

/** Named object-binding reads already enumerated by the shared flow index.
 * This states the selected fields, not whether a receiver field is data or
 * whether the resulting binding escapes; consumers retain those proofs.
 */
export const objectBindingReadsOf = (flow: ValueFlowIndex, source: ts.Expression): readonly ObjectBindingRead[] | null => {
  const parent = source.parent
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== source || !ts.isObjectBindingPattern(parent.name)) return null
  let inventory = reads.get(flow)
  if (!inventory) {
    const collected = new Map<ts.Expression, Map<ts.BindingElement, string>>()
    for (const write of flow.allWrites) {
      if (
        write.edge !== 'destructuring' ||
        write.slot !== 'member' ||
        !write.naming ||
        write.member === null ||
        !ts.isBindingElement(write.site)
      )
        continue
      let entries = collected.get(write.naming)
      if (!entries) collected.set(write.naming, (entries = new Map()))
      entries.set(write.site, write.member)
    }
    inventory = collected
    reads.set(flow, inventory)
  }
  const selected = inventory.get(source)
  const result: ObjectBindingRead[] = []
  for (const binding of parent.name.elements) {
    if (binding.dotDotDotToken || binding.initializer || !ts.isIdentifier(binding.name)) return null
    const key = selected?.get(binding)
    if (key === undefined) return null
    if (
      !flow.writesToDeclaration(binding).some((write) => write.edge === 'destructuring' && write.slot === 'whole' && write.site === binding)
    )
      return null
    result.push({ key, binding })
  }
  return result
}
