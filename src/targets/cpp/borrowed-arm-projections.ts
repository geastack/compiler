import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type { ConversionCensus } from '../../conversion/nodes.js'
import type { NativeSelectionStep } from '../../conversion/native-selection.js'
import { allOperationsOf, type IrBody } from '../../ir/model.js'
import { representationKey } from '../../representation/model.js'
import { borrowWorthy } from '../../ir/borrowed-call-arguments.js'
import type { StableBorrowEntry } from './borrowed-call-entry.js'

/** A `convert` that only names one arm of a borrowed union formal, or the payload of a borrowed optional formal. */
export interface BorrowedArmProjection {
  /** The ABI position of the borrowed formal whose arm this is. */
  readonly ordinal: number
  /** The arm's index in the formal's tagged union; `null` for the payload of a borrowed `optional` formal (`(*formal)`). */
  readonly arm: number | null
}

/** The one arm a selection recipe reads unchanged, or `null` when it does anything else. */
const identityArmOf = (step: NativeSelectionStep): number | null => {
  if (step.kind !== 'dispatch') return null
  let found: number | null = null
  for (const [index, arm] of step.arms.entries()) {
    if (arm === null) continue
    if (arm.kind !== 'identity' || found !== null) return null
    found = index
  }
  return found
}

/**
 * Converts that merely view one string arm of a union formal this body borrows.
 *
 * A native selection of `string | number` into `string` renders as a call that
 * COPIES the arm out (`std::string gea_native_selection_N(const Union&)`), so
 * a loop that names the string arm per iteration -- a document lookup that
 * scans every element with `isElementName(name, element)` -- paid one heap-or-SSO string copy, a move into the callee's
 * by-value entry and two destructions per element, for a value that never
 * changes. When the formal is a `const&` of this body's stable borrowed entry
 * (`borrowed-call-entry.ts`), the arm is a reference into storage no callee can
 * reach, so the conversion can be spelled as that reference instead: it then
 * binds straight to a borrowed callee formal, and a use that wants an owned
 * string copies from it exactly where the selection copied before.
 *
 * Only the formal itself is named, never the cell or SSA value the source
 * operand chains through: those may be moved from by a dying use before the
 * (deferred) reference is read, while a `const&` formal cannot be.
 */
export const borrowedArmProjectionsOf = (
  body: IrBody,
  entry: StableBorrowEntry | undefined,
  conversions: ConversionCensus | null
): ReadonlyMap<IrValueId, BorrowedArmProjection> => {
  const result = new Map<IrValueId, BorrowedArmProjection>()
  if (entry === undefined || conversions === null || entry.formals.size === 0) return result
  const formalOf = new Map<IrValueId, number>()
  const seeded = new Map<DeclarationId, number>()
  const writes = new Map<DeclarationId, number>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      if (operation.kind === 'parameter' && entry.formals.has(operation.ordinal)) formalOf.set(operation.result.id, operation.ordinal)
      if (operation.kind === 'binding-write') writes.set(operation.declaration, (writes.get(operation.declaration) ?? 0) + 1)
    }
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      if (operation.kind !== 'binding-write') continue
      const ordinal = formalOf.get(operation.value.value)
      if (ordinal !== undefined && writes.get(operation.declaration) === 1) seeded.set(operation.declaration, ordinal)
    }
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'binding-read') {
        const ordinal = seeded.get(operation.declaration)
        if (ordinal !== undefined) formalOf.set(operation.result.id, ordinal)
      }
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'convert' || operation.presence === 'checked' || operation.rebuild !== undefined) continue
      const ordinal = formalOf.get(operation.source.value)
      if (ordinal === undefined) continue
      const source = operation.source.representation
      const target = operation.result.representation
      // The payload of a borrowed optional formal, proven present: `(*formal)` is a reference into the
      // formal's own storage, so naming it where it is read replaces the copy of the payload (one retain
      // and, on release, one cycle-candidate dip per Ref the payload holds) the conversion made into a
      // temporary of its own. `emitConvert` confirms the rendering IS that bare dereference before it
      // takes the view; any other rendering (a widening, a checked load) keeps its copy.
      if (source.kind === 'optional' && representationKey(source.payload) === representationKey(target) && borrowWorthy(target)) {
        const optionalFormal = entry.abi.parameters[ordinal]
        if (optionalFormal !== undefined && representationKey(optionalFormal.value) === representationKey(source)) {
          result.set(operation.result.id, { ordinal, arm: null })
          continue
        }
      }
      if (source.kind !== 'tagged-union' || target.kind !== 'string') continue
      const formal = entry.abi.parameters[ordinal]
      if (formal === undefined || representationKey(formal.value) !== representationKey(source)) continue
      const node = conversions.nodeById(operation.conversionUse)
      if (node === null || (node.capability.kind !== 'atom' && node.capability.kind !== 'static')) continue
      const recipe = node.capability.materializer.nativeSelection
      if (recipe === undefined || recipe.source !== representationKey(source) || recipe.target !== representationKey(target)) continue
      if (representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
        continue
      const arm = identityArmOf(recipe.step)
      if (arm === null || source.arms[arm]?.value.kind !== 'string') continue
      result.set(operation.result.id, { ordinal, arm })
    }
  return result
}
