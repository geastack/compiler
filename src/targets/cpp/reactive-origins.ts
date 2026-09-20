import type { IrBody } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type { EmitContext, ReactiveRevisionOrigin } from './emit-context.js'
import { reactiveClassFieldClaim } from './class-properties/emit-class-properties.js'
import { reactiveRecordFieldClaim } from './emit-properties.js'

export interface ReactiveOrigins {
  readonly origins: ReadonlyMap<IrValueId, ReactiveRevisionOrigin>
  readonly bindingOrigins: ReadonlyMap<DeclarationId, ReactiveRevisionOrigin>
  readonly fieldReads: ReadonlyMap<IrValueId, ReactiveRevisionOrigin>
}

/**
 * Which values in one body carry a reactive revision cell, and which reads owe
 * a subscription -- settled before the body renders a line.
 *
 * Distinct from `reactive-dependencies.ts`, which answers a whole-program
 * question for the JSX caller (which fields does this THUNK read, and through
 * what nameable owner). This is the per-body flow: which SSA values in THIS
 * body came out of reactive state, so that a store through one of them ticks
 * the right cell.
 *
 * The channel used to be five render-time side effects: two seeds inside
 * resolvers deep in the get ladder, and three relays (`emitGet`,
 * `arrayMemberText`, `emitBindingRead`/`emitBindingWrite`) that copied an
 * origin from one value to the next as each happened to render. That made the
 * printer's own visiting order the authority over a dataflow fact, and it made
 * the seeds conditional on which rung of the ladder answered the access --
 * exactly the way a fact goes missing.
 *
 * The seeds are now two claims (`reactiveClassFieldClaim`,
 * `reactiveRecordFieldClaim`) living with the layout each asks about, and this
 * is their single walk. The relay is stated once, here: an origin is a property
 * of the VALUE, so anything read THROUGH a value that came out of reactive
 * array state keeps that state's revision cell -- `this.cells[i]` is the
 * element, `cell.color` is a field of it, and a write to either has to tick the
 * same cell. It survives the local a program parks it in, which is what the
 * binding pair carries.
 *
 * Deliberately ONE forward pass in `blockOrder`, not a fixed point. A fixed
 * point is the stronger dataflow answer and would additionally reach a binding
 * whose only write is later in the body than its read -- around a loop back
 * edge, say. That is a real difference in what gets subscribed, so it is a
 * change to make on its own evidence and gate on its own, not something to
 * smuggle in under a refactor whose whole claim is that the emitted set does
 * not move.
 */
export const reactiveOriginsOf = (ctx: EmitContext, body: IrBody): ReactiveOrigins => {
  const origins = new Map<IrValueId, ReactiveRevisionOrigin>()
  const bindingOrigins = new Map<DeclarationId, ReactiveRevisionOrigin>()
  const fieldReads = new Map<IrValueId, ReactiveRevisionOrigin>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (block === undefined) continue
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'get') {
        // The relay runs BEFORE the seeds: a field that is itself reactive
        // state names its own cell, and that outranks the one it was reached
        // through -- `cell.filled = 1` notifies the props that read that field,
        // not every row of the list the cell belongs to.
        const inherited = origins.get(operation.receiver.value)
        if (inherited !== undefined) origins.set(operation.result.id, inherited)
        const classField = reactiveClassFieldClaim(ctx, operation)
        if (classField !== null) {
          if (classField.kind === 'revision') origins.set(operation.result.id, classField.origin)
          else fieldReads.set(operation.result.id, classField.origin)
        }
        const recordField = reactiveRecordFieldClaim(ctx, operation)
        if (recordField !== null) fieldReads.set(operation.result.id, recordField)
        continue
      }
      if (operation.kind === 'binding-read') {
        const origin = bindingOrigins.get(operation.declaration)
        if (origin !== undefined) origins.set(operation.result.id, origin)
        continue
      }
      if (operation.kind === 'binding-write') {
        const written = origins.get(operation.value.value)
        if (written !== undefined) bindingOrigins.set(operation.declaration, written)
      }
    }
  }
  return { origins, bindingOrigins, fieldReads }
}
