// Repro for a database-client connection-pool probe's
// `property-access:unresolved:get:false` unmet obligations (38 rows on that
// probe; 29 of them, 76%, at the SAME site and SAME mechanism as
// fixtures/binding-carrier-repro.ts: the client's operation executor's
// `operation instanceof PipelineOperation && operation.hasWriteStage`).
//
// This is the identical pattern as binding-carrier-repro.ts, kept as its own
// file because the predicate under test is different: the `.hasWriteStage`
// read is what raises `property-access:unresolved:get:false` (the receiver's
// own carrier, `operation` narrowed to `Concrete & PipelineOperation`,
// already resolved `unresolved` -- see that file's comment for the mechanism
// in `deriveIntersection`, src/representation/derive.ts).
//
// NEGATIVE RESULT, reported per instructions rather than invented: the
// remaining 9 property-access rows on the probe (6 at one site in the
// client's abstract cursor, reading
// `options.timeoutContext.timeoutMS` after narrowing
// `options?.timeoutContext?.csotEnabled()` truthy) look like an INDEPENDENT,
// narrowing-only mechanism with no intersection or generic-class-instance
// involved. Three attempts to isolate it in a standalone fixture (plain
// optional chain; the same shape behind a default-valued intersection
// parameter `AbstractCursorOptions & Abortable = {}`; the same again inside a
// generic `AbstractCursor<TSchema>` constructor) all certified clean instead
// of reproducing the obligation -- so whatever that cursor site's real
// defect depends on (a wider generic surface? a specific census interaction?)
// is not captured here. Not fabricating a fixture for it.

abstract class AbstractOperation {
  abstract readonly name: string
}

class PipelineOperation extends AbstractOperation {
  readonly name = 'aggregate'
  hasWriteStage = true
}

class FindOperation extends AbstractOperation {
  readonly name = 'find'
  filter: string = ''
}

function tryOperation<T extends AbstractOperation>(operation: T): boolean {
  if (operation instanceof PipelineOperation) {
    return operation.hasWriteStage
  }
  return false
}

export function runFind(): boolean {
  const op = new FindOperation()
  return tryOperation(op)
}
