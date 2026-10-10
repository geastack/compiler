import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'
import { nativeFieldViewPlansOf } from '../conversion/native-field-view.js'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import type { Representation } from '../representation/model.js'
import { allOperationsOf, type IrBody } from './model.js'
import { nativeFieldViewBodyCitationsOf } from './native-field-view-facts.js'

/** Only native inherited-membership observations need these value-free hooks.
 * Closing the actual family includes an empty base, so a base-held descendant
 * can dispatch Has without demanding a boxed method or accessor result.
 */
export const nativePrototypePresenceDemandOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: Pick<ConversionCensus, 'nodeById'>
): ReadonlySet<DeclarationId> => {
  const roots = new Set<DeclarationId>()
  const viewed = new Set<string>()
  const observe = (value: Representation): void => {
    if (value.kind === 'class-ref') roots.add(value.declaration)
    else if (value.kind === 'optional') observe(value.payload)
    else if (value.kind === 'borrowed-ref') observe(value.referent)
    else if (value.kind === 'tagged-union') for (const arm of value.arms) observe(arm.value)
    else if ('shapeId' in value && 'ownership' in value && value.ownership === 'shared-refcount') viewed.add(value.shapeId)
  }
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'has-property') observe(operation.receiver.representation)
        else if (operation.kind === 'call' && operation.intrinsicReflection === 'has' && operation.arguments[0])
          observe(operation.arguments[0].representation)
      }
  const nodes = bodies.flatMap(nativeFieldViewBodyCitationsOf).flatMap((id) => {
    const node = conversions.nodeById(id)
    return node === null ? [] : [node]
  })
  const plans = nativeFieldViewPlansOf(recipeClosureOf(nodes, conversions.nodeById).values())
  const visited = new Set<(typeof plans)[number]>()
  let pending = true
  while (pending) {
    pending = false
    for (const plan of plans) {
      if (visited.has(plan) || !viewed.has(plan.target.shapeId)) continue
      visited.add(plan)
      observe(plan.source)
      pending = true
    }
  }
  const held = new Set<DeclarationId>()
  for (const root of roots)
    for (const layout of classes.values())
      if (layout.declaration === root || extendsClass(classes, layout.declaration, root))
        for (
          let current: DeclarationId | null = layout.declaration;
          current !== null && !held.has(current);
          current = classes.get(current)?.base ?? null
        )
          held.add(current)
  return held
}
