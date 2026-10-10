import { isMaterializable, type ConversionNode, type ConversionNodeResolver } from './algebra.js'
import { recipeClosureOf } from './recipe-closure.js'
import { dynamicWrapperPlanMatches } from './dynamic-wrapper.js'
import type { Representation } from '../representation/model.js'

/** Normal destinations follow the installed selector, including its sealed
 * child readers. The destination's wider storage is not an origin proof.
 */
export const dynamicResultCarriersOf = (
  node: ConversionNode | null | undefined,
  resolve: ConversionNodeResolver
): readonly Representation[] | null => {
  if (
    node === null ||
    node === undefined ||
    resolve(node.id) !== node ||
    node.source.kind !== 'dynamic' ||
    node.target.kind !== 'tagged-union'
  )
    return null
  if ([...recipeClosureOf([node], resolve).values()].some((child) => resolve(child.id) !== child || !isMaterializable(child.capability)))
    return null
  if ('materializer' in node.capability && node.capability.materializer.dynamicWrapper?.kind === 'union') {
    const plan = node.capability.materializer.dynamicWrapper
    if (!dynamicWrapperPlanMatches(plan, node.source, node.target, resolve) || plan.arms.length === 0) return null
    const indexes = new Set<number>()
    const result: Representation[] = []
    for (const arm of plan.arms) {
      const target = node.target.arms[arm.index]
      if (target === undefined || indexes.has(arm.index)) return null
      indexes.add(arm.index)
      result.push(target.value)
    }
    return result
  }
  if (node.capability.kind !== 'sum' || node.capability.arms.length === 0) return null
  const result: Representation[] = []
  const tags = new Set<string>()
  for (const arm of node.capability.arms) {
    const target = node.target.arms.find((candidate) => candidate.tag === arm.tag)
    if (target === undefined || tags.has(arm.tag) || !isMaterializable(arm.capability)) return null
    tags.add(arm.tag)
    result.push(target.value)
  }
  return result
}
