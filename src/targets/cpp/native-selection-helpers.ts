import { createHash } from 'node:crypto'
import { allOperationsOf, type IrBody } from '../../ir/model.js'
import type { ConversionCensus } from '../../conversion/nodes.js'
import type { ConversionNode, ConversionNodeId } from '../../conversion/algebra.js'
import { nativeSelectionBody } from './emit-native-selection.js'
import { cppTypeOf } from './types.js'

export interface NativeSelectionHelper {
  readonly name: string
  readonly declaration: string
  readonly definition: string
}

/** Count certified IR uses before rendering; helper selection never changes conversion authority. */
export const nativeSelectionHelpersForUses = (nodes: Iterable<ConversionNode>): ReadonlyMap<ConversionNodeId, NativeSelectionHelper> => {
  const uses = new Map<ConversionNodeId, { node: ConversionNode; count: number }>()
  for (const node of nodes) {
    const existing = uses.get(node.id)
    if (existing) existing.count++
    else uses.set(node.id, { node, count: 1 })
  }
  const result = new Map<ConversionNodeId, NativeSelectionHelper>()
  for (const { node, count } of uses.values()) {
    if (count < 2 || (node.capability.kind !== 'atom' && node.capability.kind !== 'static')) continue
    const recipe = node.capability.materializer.nativeSelection
    if (!recipe) continue
    const body = nativeSelectionBody(recipe, node.source, node.target)
    if (body === null || body.length < 1024) continue
    const name = `gea_native_selection_${createHash('sha256').update(node.id).digest('hex')}`
    const signature = `${cppTypeOf(node.target)} ${name}(const ${cppTypeOf(node.source)}& gea_selection)`
    result.set(node.id, { name, declaration: `${signature};`, definition: `${signature} { ${body} }` })
  }
  return result
}

export const nativeSelectionHelpers = (
  bodies: readonly IrBody[],
  census: ConversionCensus
): ReadonlyMap<ConversionNodeId, NativeSelectionHelper> => {
  function* nodes(): Iterable<ConversionNode> {
    for (const body of bodies) {
      for (const block of body.blocks.values()) {
        for (const operation of allOperationsOf(block)) {
          if (operation.kind !== 'convert') continue
          const node = census.nodeById(operation.conversionUse)
          if (node) yield node
        }
      }
    }
  }
  return nativeSelectionHelpersForUses(nodes())
}
