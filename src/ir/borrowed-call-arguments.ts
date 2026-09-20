import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrBody } from './model.js'

/** A private cell is owned by this invocation and cannot be assigned through
 * a closure, global, object property, or host alias. The caller supplies the
 * binding-placement/capture authority and its physical carrier, or null when
 * the cell is not private. Being spelled `const` is not proof. */
export type PrivateBorrowCell = (declaration: DeclarationId) => Representation | null

/** Formal positions whose physical body cell can stay a reference. This is
 * only a READ-ONLY proof, not an admission to borrow an arbitrary actual.
 * An effectful body needs a stable caller-owned actual or an owning entry
 * wrapper. Coroutine frames must never use these references across suspension.
 *
 * Keep the formal-cell elision contract: one same-carrier seed into a private
 * cell. Modified/captured/converted formal cells retain the owning convention.
 * No callee purity is assumed; mutation of a referent is distinct from mutation
 * of the native string/handle slot containing that referent. */
export const readonlyBorrowFormalsOf = (
  body: IrBody,
  privateCell: PrivateBorrowCell,
  dyingArguments: ReadonlySet<IrValueId>
): ReadonlySet<number> => {
  const result = new Set<number>()
  if (!body.abi) return result
  const parameters = new Map<IrValueId, number>()
  const writes = new Map<DeclarationId, { readonly value: IrValueId; readonly carrier: string }[]>()
  const reads = new Map<DeclarationId, IrValueId[]>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      if (operation.kind === 'parameter') parameters.set(operation.result.id, operation.ordinal)
      if (operation.kind === 'binding-write') {
        const entries = writes.get(operation.declaration) ?? []
        entries.push({ value: operation.value.value, carrier: representationKey(operation.value.representation) })
        writes.set(operation.declaration, entries)
      }
      if (operation.kind === 'binding-read') {
        const entries = reads.get(operation.declaration) ?? []
        entries.push(operation.result.id)
        reads.set(operation.declaration, entries)
      }
    }
  for (const [value, ordinal] of parameters) {
    const parameter = body.abi.parameters[ordinal]
    if (!parameter || parameter.ownership === 'borrowed') continue
    let allowed = true
    for (const [declaration, entries] of writes) {
      if (!entries.some((entry) => entry.value === value)) continue
      const cell = privateCell(declaration)
      if (
        cell === null ||
        representationKey(cell) !== representationKey(parameter.value) ||
        entries.length !== 1 ||
        entries[0]?.carrier !== representationKey(parameter.value)
      ) {
        allowed = false
        break
      }
      // A formal already proven to DIE into a consuming use is not merely
      // unsafe to alias -- making it `const&` silently downgrades the move
      // that use was built on. `box.label = text` resolves `gea_arg_0->label
      // = std::move(gea_arg_1)` to the COPY assignment when `gea_arg_1` is a
      // `const&`, with no diagnostic anywhere. `ir/transfer.ts`'s
      // `buildDyingArgumentIndex` is the one authority on which values die,
      // checked here against this formal's own READS of its seeded cell --
      // never the raw incoming parameter value itself. That raw value always
      // has exactly one reader, the seed write the formal-cell elision
      // contract requires, so `buildDyingArgumentIndex` always reports it as
      // dying into that write; asking about the PARAMETER refused every
      // formal unconditionally (`readonly` came back empty for every body
      // whose whole-body proof needed this weaker one), not just the ones
      // that alias into a consuming use. The stronger `program-facts.ts`
      // proof (`borrowedFormalsOf`) has always asked this same question the
      // same way, against the cell's reads, not the parameter's own value.
      if ((reads.get(declaration) ?? []).some((read) => dyingArguments.has(read))) {
        allowed = false
        break
      }
    }
    if (allowed) result.add(ordinal)
  }
  return result
}

/** Actuals immune to writes made by an invoked function or its callbacks.
 *
 * This is about the SLOT, not deep immutability: a private Ref<Array> keeps its
 * identity while the callee changes array elements, exactly as passing that
 * reference by value does. An object field containing the Ref is not private.
 *
 * Parameter actuals are safe only under the entry contract: their body either
 * owns them or was itself entered with a stable borrow. An owning ABI wrapper
 * closes this induction at every external/unknown call. These facts must not
 * be used to change that ABI or admit an unguarded external borrowed entry.
 * A receiver actual is under the identical contract -- a method's `this` is
 * always either owned by its allocation or borrowed from its own caller under
 * this same induction -- so it is admitted on the same terms as a parameter.
 *
 * Deliberately exclude property reads, conversions and call results: an emitter
 * may defer them as a reference into mutable storage. A future materialization
 * proof may admit them; the source representation alone cannot do so.
 *
 * The consumer must also exclude a call whose other owning arguments can MOVE
 * one of these slots during argument evaluation. Const-reference binding itself
 * does not move, even if the operand is spelled std::move by last-use analysis. */
export const stableBorrowActualsOf = (body: IrBody, privateCell: PrivateBorrowCell): ReadonlySet<IrValueId> => {
  const result = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      if (operation.kind === 'parameter') result.add(operation.result.id)
      if (operation.kind === 'constant') result.add(operation.result.id)
      if (operation.kind === 'binding-read' && privateCell(operation.declaration) !== null) result.add(operation.result.id)
      // `this` is under the same entry contract as a parameter: THIS body was
      // entered with it already owned or already borrowed by its own caller,
      // so it stays alive for this body's whole execution, including any call
      // this body makes. Forwarding `this` on to another call is exactly the
      // `helper(this)` shape a method body written across several small
      // methods takes constantly, and none of that shape could ever borrow
      // without this: `this` is a reference, never a parameter/binding-read.
      if (operation.kind === 'receiver') result.add(operation.result.id)
    }
  return result
}
