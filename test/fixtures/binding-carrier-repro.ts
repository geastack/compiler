// Repro for the mongodb CMAP-ping probe's `binding-carrier:selected` unmet
// obligations (51 rows on that probe). The dominant shape (29 of 51, all at
// mongodb/src/operations/execute_operation.ts:198): a generic function
// monomorphized for a concrete subclass narrows its own type parameter via
// `instanceof` against an UNRELATED sibling subclass. TypeScript computes the
// narrowed type as an intersection of the two nominal classes
// (`Concrete & Other`); `deriveIntersection` (src/representation/derive.ts)
// only fast-paths "exactly one nominal class member", so two nominal classes
// fall through to the generic record-merge, which refuses any class-instance
// member by design (merging one would silently drop its identity) -- hence
// `unresolved(no primitive for an intersection whose member ... (class-instance)
// is not a record shape)`.

abstract class AbstractOperation {
  abstract readonly name: string
}

class AggregateOperation extends AbstractOperation {
  readonly name = 'aggregate'
  hasWriteStage = true
}

class FindOperation extends AbstractOperation {
  readonly name = 'find'
  filter: string = ''
}

function tryOperation<T extends AbstractOperation>(operation: T): boolean {
  if (operation instanceof AggregateOperation) {
    return operation.hasWriteStage
  }
  return false
}

export function runFind(): boolean {
  const op = new FindOperation()
  return tryOperation(op)
}
