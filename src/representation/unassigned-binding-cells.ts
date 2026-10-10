import type { DeclarationId, SemanticResultId } from '../identity/ids.js'
import { withoutFunctionSpecialization } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticCaller } from '../semantics/model/operands.js'
import { resultOf } from '../semantics/model/operands.js'

/**
 * The `let`/`var` cells declared without an initializer that a read can
 * observe before any write, and every read of one.
 *
 * `let x: T` with no initializer binds `undefined` (ECMA-262
 * LexicalDeclaration evaluation with no Initializer), and the checker's
 * definite-assignment analysis is scoped to one function body: a read in the
 * declaring body is proven assigned or rejected, but a read from any other
 * function -- a module helper, a closure -- is simply assumed assigned. So
 * such a cell's declared type is a claim the language does not enforce there.
 * A lazily loaded optional module (`let codec: Codec`, then
 * `if (!codec) codec = loadCodec()` in a function) relies on reading that
 * `undefined` back; carried as its declared `T`, `!codec` has no absence to
 * see and the loader never runs.
 *
 * A cell with such a read therefore carries the absence, and so does every
 * read of it -- the storage is one carrier, and a read in the declaring body
 * that the checker proved is still a load of that storage. A read feeding a
 * position that states `T` converts through the ordinary checked unwrap. A
 * cell every read of which sits in the declaring body keeps its declared
 * carrier: the checker's analysis is the proof there.
 *
 * Same shape as an unwritten static field (`static-field-cells.ts`), whose
 * carrier helper this shares.
 */
export interface UnassignedBindingAbsence {
  readonly declarations: ReadonlySet<DeclarationId>
  readonly results: ReadonlySet<SemanticResultId>
}

const ownerOf = (caller: SemanticCaller): string =>
  caller.kind === 'function' ? `f:${withoutFunctionSpecialization(caller.functionId)}` : `r:${caller.regionId}`

export const unassignedBindingAbsenceOf = (graph: SemanticGraph): UnassignedBindingAbsence => {
  const declared = new Map<DeclarationId, { owner: string; result: SemanticResultId }>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || operation.action !== 'declare' || !operation.mutable) continue
    // A host-supplied or CommonJS wrapper cell is written from outside the program.
    if (operation.external || operation.commonJs) continue
    const value = resultOf(operation, 'value')
    if (value) declared.set(operation.declaration, { owner: ownerOf(operation.caller), result: value.id })
  }
  const declarations = new Set<DeclarationId>()
  const results = new Set<SemanticResultId>()
  if (declared.size === 0) return { declarations, results }
  const reads = new Map<DeclarationId, SemanticResultId[]>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || operation.action !== 'read') continue
    const cell = declared.get(operation.declaration)
    const value = resultOf(operation, 'value')
    if (!cell || !value) continue
    const bucket = reads.get(operation.declaration)
    if (bucket) bucket.push(value.id)
    else reads.set(operation.declaration, [value.id])
    if (ownerOf(operation.caller) !== cell.owner) declarations.add(operation.declaration)
  }
  for (const declaration of declarations) {
    const cell = declared.get(declaration)
    if (cell) results.add(cell.result)
    for (const read of reads.get(declaration) ?? []) results.add(read)
  }
  return { declarations, results }
}
