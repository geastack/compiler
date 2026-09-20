import type ts from 'typescript'
import type { FlowEdgeKind, ValueFlowIndex } from './flow/model.js'

/** Reassignment consumes the same settled writes as type inference and call attribution. */
export interface ReassignedBindingCensus {
  readonly isReassignedIn: (file: ts.SourceFile, symbol: ts.Symbol) => boolean
  readonly isReassignedAnywhere: (symbol: ts.Symbol) => boolean
}

const reassignmentEdges: ReadonlySet<FlowEdgeKind> = new Set([
  'identifier-assignment',
  'property-assignment',
  'index-assignment',
  'compound-assignment',
  'logical-assignment',
  'destructuring',
  'destructuring-default',
  'iteration-binding',
  'delete'
])

/**
 * Being mentioned in a literal is a read, not a possible destructuring write.
 * The flow index already distinguishes assignment-pattern targets from their
 * keys, defaults and ordinary literal values, including shorthand targets.
 */
export const createReassignedBindingCensus = (checker: ts.TypeChecker, flow: ValueFlowIndex): ReassignedBindingCensus => {
  const byFile = new Map<ts.SourceFile, Set<ts.Symbol>>()
  const all = new Set<ts.Symbol>()
  for (const write of flow.allWrites) {
    if (write.slot !== 'whole' || !reassignmentEdges.has(write.edge)) continue
    const file = write.site.getSourceFile()
    const written = byFile.get(file) ?? new Set<ts.Symbol>()
    byFile.set(file, written)
    for (const symbol of [write.target.symbol, write.target.nameSymbol]) {
      if (!symbol) continue
      // Local and exported namespace symbols name the same mutable cell.
      for (const identity of [symbol, checker.getExportSymbolOfSymbol(symbol)]) {
        written.add(identity)
        all.add(identity)
      }
    }
  }
  const has = (written: ReadonlySet<ts.Symbol> | undefined, symbol: ts.Symbol): boolean =>
    written?.has(symbol) === true || written?.has(checker.getExportSymbolOfSymbol(symbol)) === true
  return {
    isReassignedAnywhere: (symbol) => has(all, symbol),
    isReassignedIn: (file, symbol) => has(byFile.get(file), symbol)
  }
}
