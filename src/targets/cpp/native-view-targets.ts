import type { ConversionNode } from '../../conversion/algebra.js'
import { nativeViewOriginsOf } from '../../conversion/native-view-origins.js'
import { representationKey, type Representation } from '../../representation/model.js'

/** Native origin edges belong to precisely the view allocations certified for this program. */
export const nativeViewTargetsOf = (nodes: Iterable<ConversionNode>): readonly string[] => [
  ...new Set(nativeViewOriginsOf(nodes).map((origin) => origin.target.shapeId))
]

/** The originals each certified view target can retain, by the target's shape: the same edges as `nativeViewTargetsOf`. */
export const nativeViewSourcesOf = (nodes: Iterable<ConversionNode>): ReadonlyMap<string, readonly Representation[]> => {
  const sources = new Map<string, Map<string, Representation>>()
  for (const origin of nativeViewOriginsOf(nodes)) {
    const held = sources.get(origin.target.shapeId) ?? new Map<string, Representation>()
    held.set(representationKey(origin.source), origin.source)
    sources.set(origin.target.shapeId, held)
  }
  return new Map([...sources].map(([shape, held]) => [shape, [...held.values()]]))
}
