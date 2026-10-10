import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { passingOf, representationKey, type Representation } from '../representation/model.js'
import { allOperationsOf, type IrBody } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/** A private cell is owned by this invocation and cannot be assigned through
 * a closure, global, object property, or host alias. The caller supplies the
 * binding-placement/capture authority and its physical carrier, or null when
 * the cell is not private. Being spelled `const` is not proof. */
export type PrivateBorrowCell = (declaration: DeclarationId) => Representation | null

/**
 * Whether copying a value of this carrier costs a retain (and, on release, a
 * cycle-candidate buffering): the carriers a reference entry is worth
 * minting for. `passingOf` answers it for a bare handle or string, but an
 * `optional` states no ownership of its own, a tagged union of handles is
 * copied arm by arm -- and
 * an options-heavy library passes its options record as `Optional<Ref<...>>`
 * at nearly every level, and most of the records each operation touches were
 * buffered as cycle candidates from exactly these by-value copies.
 */
const containsBox = (value: Representation): boolean =>
  value.kind === 'dynamic' ||
  (value.kind === 'optional' && containsBox(value.payload)) ||
  (value.kind === 'tagged-union' && value.arms.some((arm) => containsBox(arm.value)))

export const borrowWorthy = (value: Representation): boolean => {
  if (value.kind === 'optional') return borrowWorthy(value.payload)
  // A union with a box arm is refused for the reason a bare box is (below):
  // a store through that arm is a non-const operation on the box inside the
  // union. `dictionary-or-any-union-computed-read.runtime.ts` writes
  // `doc[key] = v` through a `Record<string, T> | any` formal and its
  // borrowed entry failed to compile on the `any` arm's `setProperty`.
  if (value.kind === 'tagged-union')
    return !value.arms.some((arm) => containsBox(arm.value)) && value.arms.some((arm) => borrowWorthy(arm.value))
  // Not a `dynamic` box: a property store through it (`reflectSet`) is a
  // non-const operation on the box itself, and the read-only proof sees only
  // binding writes, not stores through the value -- an `options[key] = value`
  // written through exactly such a formal made the borrowed entry fail to
  // compile.
  return passingOf(value) === 'const-ref'
}

/**
 * Whether a body only ever READS an `any`/`unknown` formal as a whole.
 *
 * `borrowWorthy` refuses a `dynamic` box outright because a store through it
 * (`reflectSet`) is a non-const operation on the box, which does not compile
 * against a `const Value&`. That is a fact about the body, not the carrier: a
 * type guard such as `isDate(x)`/`isRegExp(x)`/`isUint8Array(x)` asks
 * the box a question (`instanceof`, `typeof`, the Object.prototype.toString
 * tag, an equality) and passes it on, and every nested value a serializer
 * visits paid a by-value copy of the box -- one retain, and on release one
 * cycle-candidate buffering of the object it holds -- per guard.
 *
 * Closed allowlist rather than a denylist of stores: a use this function does
 * not name keeps the owning entry, so a new emission that mutates the box can
 * never reach a `const&` through here. A use is allowed when it is a question
 * (`ObjectTag`, `typeof`, `instanceof`, an equality, a branch on it), a plain
 * copy (a return, a binding write, an argument of a direct call into a program
 * body -- never the callee or receiver, which are invoked through the box).
 */
export const dynamicFormalIsReadOnly = (body: IrBody, ordinal: number): boolean => {
  let parameter: IrValueId | null = null
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'parameter' && operation.ordinal === ordinal) parameter = operation.result.id
  if (parameter === null) return false
  const names = new Set<IrValueId>([parameter])
  const cells = new Set<DeclarationId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'binding-write' && operation.value.value === parameter) cells.add(operation.declaration)
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'binding-read' && cells.has(operation.declaration)) names.add(operation.result.id)
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) {
      if (!operandsOfIrOperation(operation).some((operand) => names.has(operand.value))) continue
      switch (operation.kind) {
        case 'compute': {
          const question =
            operation.form === 'typeof' ||
            operation.form === 'instanceof' ||
            operation.form === 'equality' ||
            (operation.form === 'unary' && operation.operator === 'ObjectTag')
          if (!question) return false
          break
        }
        case 'branch':
        case 'return':
        case 'binding-write':
          break
        case 'call':
          // Only a call into a program body, whose formal is a copy or a
          // `const&`: a host template's frame may take the box non-const.
          if (
            operation.target?.kind !== 'direct' ||
            names.has(operation.callee.value) ||
            (operation.receiver && names.has(operation.receiver.value))
          )
            return false
          break
        default:
          return false
      }
    }
  return true
}

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
