import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classStaticMemberOf } from '../projection/fields.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrBody } from './model.js'

/**
 * Every `ClassName.KEY = value` site the whole program's lowered bodies
 * contain, folded into one table keyed by (class declaration, key).
 *
 * Walked over the IR, not the semantic graph: whether a receiver's carrier
 * really is `constructor-family`, and which class(es) it names, is a
 * representation-plan answer, and a lowered `IrOperand` already carries it
 * (`operation.receiver.representation`) -- re-deriving that from the semantic
 * graph would risk a second opinion that could disagree with the one the plan
 * actually selected.
 *
 * This lives in `ir/` rather than in the C++ target, which is where it was
 * first written, because two unrelated consumers need the same answer and the
 * fact itself is an IR fact. The target adds the mangled C++ storage name it
 * renders through; the reflection census asks only whether the slot exists and
 * what carrier it holds. Had the census stayed in the target, the census would
 * have had to re-derive it -- exactly the two-authorities drift the original
 * comment warns about.
 *
 * A computed key, or a key no `constant` operation in the SAME body accounts
 * for, is skipped rather than guessed at: nothing downstream can declare
 * storage for a name it cannot read back off the body's own operations. A
 * static METHOD or ACCESSOR key is skipped because each already has a callable
 * home. Declared static fields are claimed from the store their class-lifecycle
 * event lowers: that store carries the initializer's selected representation
 * and runs in the enclosing region's source order, so the census needs no
 * second opinion about either the field's type or its initial value.
 *
 * Two writes to the same (declaration,key) whose VALUE representations
 * disagree are refused together (`conflicts`) rather than one silently
 * overwriting the storage the other implied: a consumer that later widened one
 * writer's value into the other's carrier would be inventing a conversion this
 * census never proved sound. `conflicts` names each such pair as
 * `"<declaration>.<key>"`; the caller decides what a non-empty list means.
 */
export interface ClassStaticFieldSlots {
  readonly slots: ReadonlyMap<DeclarationId, ReadonlyMap<string, Representation>>
  readonly conflicts: readonly string[]
}

/**
 * Which class of a `constructor-family`'s members owns `key`'s static storage.
 *
 * The one selection rule, so the census and every later lookup name the same
 * class for the same receiver. A key no static member declares is the
 * assignment-only idiom and belongs to the first member that could hold it. A
 * declared static FIELD has the same storage requirement, since its
 * class-lifecycle event has already become an ordinary `set` at the exact
 * evaluation point. Methods and accessors remain callable members and must not
 * acquire a second storage location.
 */
export const staticFieldOwnerOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  members: readonly DeclarationId[],
  key: string
): DeclarationId | undefined => {
  const member = members.find((candidate) => {
    if (!classes.has(candidate)) return false
    const site = classStaticMemberOf(classes, candidate, key)
    return site === null || site.kind === 'field'
  })
  // Through `staticOwner`: the physical layouts of one generic are several
  // structs and ONE constructor object, so `Box.count` is one cell whether it
  // is written inside `Box<number>`'s constructor, inside `Box<string>`'s,
  // or through the class binding itself. Keying storage on the struct would
  // give one `count` per layout, and `Box.count` would read whichever the
  // last write happened to land in.
  return member === undefined ? undefined : staticStorageOwnerOf(classes, member)
}

/** The class one class's static storage lives in: itself, or the generic root whose layouts it is one of. */
export const staticStorageOwnerOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId): DeclarationId =>
  classes.get(declaration)?.staticOwner ?? declaration

/** The carrier `ClassName.KEY` is stored in, or null when the census proved none. */
export const staticFieldSlotOf = (
  census: ClassStaticFieldSlots,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  members: readonly DeclarationId[],
  key: string
): Representation | null => {
  const owner = staticFieldOwnerOf(classes, members, key)
  return owner === undefined ? null : (census.slots.get(owner)?.get(key) ?? null)
}

export const censusClassStaticFieldSlots = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): ClassStaticFieldSlots => {
  const byDeclaration = new Map<DeclarationId, Map<string, Representation>>()
  const conflicts = new Set<string>()
  const declaredFields = new Set<string>()
  for (const [declaration, layout] of classes) {
    // Keyed by the storage owner, which for one physical layout of a generic
    // is the root every layout shares; the layouts carry identical static
    // members, so the repeats agree by construction.
    const owner = staticStorageOwnerOf(classes, declaration)
    for (const field of layout.staticFields) {
      if (field.representation === null || field.representation.kind === 'unresolved' || field.representation.kind === 'void') continue
      const perClass = byDeclaration.get(owner) ?? new Map<string, Representation>()
      byDeclaration.set(owner, perClass)
      perClass.set(field.key, field.representation)
      declaredFields.add(`${owner}.${field.key}`)
    }
  }
  for (const body of bodies) {
    // Whole-body first pass: a `constant` operation feeding a later block's
    // key is exactly as legitimate as one in the same block, and a single
    // forward-only scan would miss it across a back edge.
    const constants = new Map<IrValueId, string>()
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) if (operation.kind === 'constant') constants.set(operation.result.id, operation.text)
    }
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind !== 'set' && operation.kind !== 'define-own-property') continue
        const receiver = operation.receiver.representation
        if (receiver.kind !== 'constructor-family') continue
        const key = constants.get(operation.key.value)
        if (key === undefined) continue
        const declaration = staticFieldOwnerOf(classes, receiver.members, key)
        if (declaration === undefined) continue
        const representation = operation.value.representation
        const perClass = byDeclaration.get(declaration) ?? new Map<string, Representation>()
        byDeclaration.set(declaration, perClass)
        const existing = perClass.get(key)
        const conflictId = `${declaration}.${key}`
        if (conflicts.has(conflictId)) continue
        if (existing !== undefined) {
          // A declared field's own carrier is the storage authority. Each
          // write is converted against it by the property emitter; differing
          // source carriers such as `Uint8Array` stored into
          // `Uint8Array | null` are expected and do not redefine the cell.
          if (declaredFields.has(conflictId)) continue
          if (representationKey(existing) === representationKey(representation)) continue
          perClass.delete(key)
          conflicts.add(conflictId)
          continue
        }
        perClass.set(key, representation)
      }
    }
  }
  return { slots: byDeclaration, conflicts: [...conflicts] }
}
