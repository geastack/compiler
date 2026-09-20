import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { stringConstantsOf } from './dead-values.js'
import { dominatorTreeOf } from './dominance.js'
import { allOperationsOf, type ComputeOperation, type IrBlockId, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

export type TypeQueryOperand = { readonly kind: 'tag'; readonly operand: IrOperand } | { readonly kind: 'literal'; readonly text: string }
export interface TypeQueryComparison {
  readonly left: TypeQueryOperand
  readonly right: TypeQueryOperand
  readonly unequal: boolean
}

/** A typeof result consumed only by equality tests needs its finite type tag,
 * not a constructed string. This is a snapshot at the query's original site,
 * never a new query at the comparison (the input may have changed meanwhile).
 * Native storage is confined to SSA values and private, single-writer cells
 * whose write dominates every read. Any escape invalidates the entire chain.
 * The caller supplies the existing placement/capture proof, not a new census. */
export const typeQueryResultsOf = (
  body: IrBody,
  privateCell: (declaration: DeclarationId) => boolean
): {
  readonly values: ReadonlySet<IrValueId>
  readonly bindings: ReadonlySet<DeclarationId>
  readonly comparisons: ReadonlyMap<ComputeOperation, TypeQueryComparison>
} => {
  const values = new Set<IrValueId>()
  const bindings = new Set<DeclarationId>()
  const comparisons = new Map<ComputeOperation, TypeQueryComparison>()
  const operations = [...body.blocks.values()].flatMap(allOperationsOf)
  for (const operation of operations)
    if (operation.kind === 'compute' && operation.form === 'typeof' && operation.result.representation.kind === 'string')
      values.add(operation.result.id)
  if (values.size === 0 || body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0)
    return { values: new Set(), bindings, comparisons }

  const constants = stringConstantsOf(body)
  const dominance = dominatorTreeOf(body)
  const uses = new Map<IrValueId, IrOperation[]>()
  const writes = new Map<DeclarationId, { value: IrValueId; block: IrBlockId; position: number }[]>()
  const reads = new Map<DeclarationId, { value: IrValueId; block: IrBlockId; position: number; string: boolean }[]>()
  for (const block of body.blocks.values())
    for (const [position, operation] of allOperationsOf(block).entries()) {
      for (const operand of operandsOfIrOperation(operation)) {
        const sites = uses.get(operand.value) ?? []
        sites.push(operation)
        uses.set(operand.value, sites)
      }
      if (operation.kind === 'binding-write') {
        const sites = writes.get(operation.declaration) ?? []
        sites.push({ value: operation.value.value, block: block.id, position })
        writes.set(operation.declaration, sites)
      }
      if (operation.kind === 'binding-read') {
        const sites = reads.get(operation.declaration) ?? []
        sites.push({ value: operation.result.id, block: block.id, position, string: operation.result.representation.kind === 'string' })
        reads.set(operation.declaration, sites)
      }
    }
  let changed = true
  while (changed) {
    changed = false
    for (const [declaration, sites] of writes) {
      const seed = sites[0]
      if (bindings.has(declaration) || sites.length !== 1 || !seed || !values.has(seed.value) || !privateCell(declaration)) continue
      const loaded = reads.get(declaration) ?? []
      if (
        !loaded.every(
          (read) => read.string && (seed.block === read.block ? seed.position < read.position : dominance.dominates(seed.block, read.block))
        )
      )
        continue
      bindings.add(declaration)
      for (const read of loaded) values.add(read.value)
      changed = true
    }
  }
  const isComparison = (operation: IrOperation): operation is ComputeOperation =>
    operation.kind === 'compute' &&
    (operation.form === 'equality' || operation.form === 'binary') &&
    ['===', '!==', '==', '!='].includes(operation.operator) &&
    operation.operands.length === 2 &&
    operation.operands.every(
      (operand) => values.has(operand.value) || (operand.representation.kind === 'string' && constants.has(operand.value))
    )

  // Removing an escaped root also removes every dependent cell/read; removing
  // an escaped read propagates back through its cell to the query producer.
  changed = true
  while (changed) {
    changed = false
    for (const value of values)
      if (!(uses.get(value) ?? []).every((use) => isComparison(use) || (use.kind === 'binding-write' && bindings.has(use.declaration)))) {
        values.delete(value)
        changed = true
      }
    for (const [declaration, sites] of writes) {
      if (!bindings.has(declaration)) continue
      const loaded = reads.get(declaration) ?? []
      if (!sites.every((site) => values.has(site.value)) || !loaded.every((site) => values.has(site.value))) {
        bindings.delete(declaration)
        for (const read of loaded) values.delete(read.value)
        changed = true
      }
    }
  }
  const operandOf = (operand: IrOperand): TypeQueryOperand =>
    values.has(operand.value) ? { kind: 'tag', operand } : { kind: 'literal', text: constants.get(operand.value)! }
  for (const operation of operations)
    if (isComparison(operation) && operation.operands.some((operand) => values.has(operand.value)))
      comparisons.set(operation, {
        left: operandOf(operation.operands[0]!),
        right: operandOf(operation.operands[1]!),
        unequal: operation.operator === '!==' || operation.operator === '!='
      })
  return { values, bindings, comparisons }
}
