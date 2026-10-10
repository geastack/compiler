import type { ConversionNode } from '../../conversion/algebra.js'
import { nativeViewOriginsOf } from '../../conversion/native-view-origins.js'

/** Native origin edges belong to precisely the view allocations certified for this program. */
export const nativeViewTargetsOf = (nodes: Iterable<ConversionNode>): readonly string[] => [
  ...new Set(nativeViewOriginsOf(nodes).map((origin) => origin.target.shapeId))
]
