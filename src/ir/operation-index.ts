import type { OperationId } from '../identity/ids.js'
import type { SemanticOperation } from '../semantics/model/operations.js'

/**
 * The first operation of a graph, in insertion order, that a predicate on one
 * key admits -- answered from an index built by one walk of the graph.
 *
 * Lowering asked "which operation is this class's heritage evaluation" by
 * copying every operation of the program into an array and scanning it, once
 * per class allocation. On a large program that is a copy of the whole graph
 * per class, seconds of pure copying and the garbage that goes with it. The
 * index keeps the first match per key, which is exactly what `find` returned.
 */
export type OperationIndexSelection = (operation: SemanticOperation) => { readonly key: unknown } | null

const indexes = new WeakMap<ReadonlyMap<OperationId, SemanticOperation>, Map<OperationIndexSelection, Map<unknown, SemanticOperation>>>()

export const firstOperationByKey = (
  operations: ReadonlyMap<OperationId, SemanticOperation>,
  selection: OperationIndexSelection,
  key: unknown
): SemanticOperation | undefined => {
  let bySelection = indexes.get(operations)
  if (!bySelection) indexes.set(operations, (bySelection = new Map()))
  let index = bySelection.get(selection)
  if (!index) {
    index = new Map()
    for (const operation of operations.values()) {
      const selected = selection(operation)
      if (selected !== null && !index.has(selected.key)) index.set(selected.key, operation)
    }
    bySelection.set(selection, index)
  }
  return index.get(key)
}
