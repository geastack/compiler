import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import { allOperationsOf, type IrBody, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

export interface BodyOperationPosition {
  readonly block: object
  readonly index: number
}

/** Every operation of one body generation, by defining value, by position and by written binding. */
export interface BodyOperationIndex {
  readonly operations: readonly IrOperation[]
  readonly definitions: ReadonlyMap<IrValueId, IrOperation>
  readonly positions: ReadonlyMap<IrOperation, BodyOperationPosition>
  readonly writes: ReadonlyMap<DeclarationId, readonly Extract<IrOperation, { kind: 'binding-write' }>[]>
}

// Keyed by the bodies map one publication hands every pass: the data-slot
// census and the prototype source authority each walked the whole program into
// the same tables, and on a large program each walk was seconds of map
// insertion. A published body generation is never written, so one index per
// map answers every pass that reads it.
const indexes = new WeakMap<ReadonlyMap<PhysicalBodyId, IrBody>, BodyOperationIndex>()

export const bodyOperationIndexOf = (bodies: ReadonlyMap<PhysicalBodyId, IrBody>): BodyOperationIndex => {
  const remembered = indexes.get(bodies)
  if (remembered !== undefined) return remembered
  const operations: IrOperation[] = []
  const definitions = new Map<IrValueId, IrOperation>()
  const positions = new Map<IrOperation, BodyOperationPosition>()
  const writes = new Map<DeclarationId, Extract<IrOperation, { kind: 'binding-write' }>[]>()
  for (const body of bodies.values())
    for (const block of body.blocks.values())
      for (const [index, operation] of allOperationsOf(block).entries()) {
        positions.set(operation, { block, index })
        operations.push(operation)
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
        if (operation.kind === 'binding-write') {
          const bucket = writes.get(operation.declaration) ?? []
          bucket.push(operation)
          writes.set(operation.declaration, bucket)
        }
      }
  const built: BodyOperationIndex = { operations, definitions, positions, writes }
  indexes.set(bodies, built)
  return built
}
