import type { FunctionId, IrValueId } from '../../identity/ids.js'
import { borrowWorthy, dynamicFormalIsReadOnly, readonlyBorrowFormalsOf, type PrivateBorrowCell } from '../../ir/borrowed-call-arguments.js'
import { allOperationsOf, type IrBody, type IrOperand } from '../../ir/model.js'
import { DyingArgumentSet } from '../../ir/transfer.js'
import { representationKey, type CallableAbi } from '../../representation/model.js'
import { cppBodyName } from './types.js'

/** The original body name remains an owning entry wrapper. This additional
 * entry is internal and may be selected only with stable-actual evidence.
 * No callable's public ABI or thunk identity names the borrowed body. */
export interface StableBorrowEntry {
  readonly owner: FunctionId
  readonly name: string
  readonly abi: CallableAbi
  readonly formals: ReadonlySet<number>
  /**
   * Whether the body's declared signature narrows an integer formal or its
   * result. The entry then spells those narrowed types exactly as the owning
   * entry does, so a direct call reaches either with the same arguments; a
   * carrier-level adapter (`callKnownBorrowed`) passes the unnarrowed ABI and
   * must keep the thunk, which converts at that boundary.
   */
  readonly narrowedNumericAbi: boolean
}

export const stableBorrowEntryOf = (
  body: IrBody,
  owner: FunctionId,
  privateCell: PrivateBorrowCell,
  originalBorrowed: ReadonlySet<number>,
  dyingArguments: ReadonlySet<IrValueId>,
  admission: {
    readonly captureFree: boolean
    readonly synchronous: boolean
    readonly singleBody: boolean
    readonly narrowedNumericAbi: boolean
  }
): StableBorrowEntry | null => {
  const abi = body.abi
  if (body.sourceOwner !== owner || !admission.captureFree || !admission.synchronous || !admission.singleBody) return null
  // A receiver is not disqualifying: `signatureOf`/`bodyFormalsOf` already
  // spell a method's `this` from `borrowsReceiver`, independently of the
  // `formals` this function returns, so a method's OWN non-receiver formals
  // are exactly as eligible for the extra reference entry as a free
  // function's. `readonlyBorrowFormalsOf` below never inspects `abi.receiver`
  // either -- it only walks `parameter` operations, which never include the
  // receiver. `restFrom` stays excluded: a rest parameter's actual is an
  // Array the caller built for this call alone, never a stable binding.
  if (!abi || abi.restFrom !== null) return null
  // No callee-side effect condition. An earlier revision refused the entry
  // to any body that calls a known callee the whole-program effect proof had
  // not shown pure -- which is nearly every body, since that proof admits
  // only leaves made of field reads and arithmetic (a recursive serializer, a
  // request path and options plumbing all carried a by-value handle per
  // level because of it). The hazard it guarded, a callee
  // writing the slot a reference formal is bound to, is ruled out on the
  // CALLER's side already: `stableBorrowEntryAccepts` binds a reference
  // formal only to a private cell, a parameter, a constant or `this` of the
  // caller, none of which any callee can reach -- a private cell is written
  // by its own body alone, and that body is suspended for the whole call. A
  // property read, the one actual a callee could write through, is never a
  // stable actual (`stableBorrowActualsOf`).
  const readonly = readonlyBorrowFormalsOf(body, privateCell, dyingArguments)
  const formals = new Set(
    [...readonly].filter((ordinal) => {
      const parameter = abi.parameters[ordinal]
      return (
        parameter !== undefined &&
        (borrowWorthy(parameter.value) || (parameter.value.kind === 'dynamic' && dynamicFormalIsReadOnly(body, ordinal)))
      )
    })
  )
  if (![...formals].some((ordinal) => !originalBorrowed.has(ordinal))) return null
  // Never revoke an established, stronger effect-based borrow proof.
  for (const ordinal of originalBorrowed) formals.add(ordinal)
  return { owner, name: `${cppBodyName(owner)}_stable_borrow`, abi, formals, narrowedNumericAbi: admission.narrowedNumericAbi }
}

/** A private caller slot survives arbitrary program re-entry. All extra
 * reference formals must bind such slots; otherwise use the existing owning
 * entry, whose snapshots bind the borrowed implementation safely.
 *
 * Reject mixed move/borrow evaluation: C++ may evaluate an owning sibling's
 * std::move before another argument binds a reference to the same slot.
 * Conservatively reject ANY potentially moving reference sibling rather than
 * claiming an alias distinction the emitter's deferred expressions may erase.
 * Scalars cannot move a string/handle slot. Binding a borrowed formal does
 * not itself move from its argument. */
export const stableBorrowEntryAccepts = (
  entry: StableBorrowEntry,
  actuals: readonly IrOperand[],
  stable: ReadonlySet<IrValueId>,
  dyingArguments: ReadonlySet<IrValueId>
): boolean => {
  for (const ordinal of entry.formals) {
    const actual = actuals[ordinal]
    const formal = entry.abi.parameters[ordinal]
    if (!actual || !formal || !stable.has(actual.value)) return false
    // Conversion expressions can expose a different physical lifetime. Admit
    // only the exact carried input; other calls retain their owning adapter.
    if (representationKey(actual.representation) !== representationKey(formal.value)) return false
  }
  return actuals.every(
    (actual, ordinal) =>
      entry.formals.has(ordinal) ||
      !dyingArguments.has(actual.value) ||
      !(borrowWorthy(actual.representation) || actual.representation.kind === 'dynamic')
  )
}

/**
 * The borrowed positions a call copies into a temporary of the formal's own
 * carrier so that it can still enter the borrowed entry, or null when the
 * entry is refused.
 *
 * A reference formal bound to a temporary the call itself made is as private
 * as a caller-owned local: nothing else can name it, and it lives until the end
 * of the full-expression, past the callee's return. So an actual that is not a
 * stable slot -- a field or element read the printer may withhold as a
 * reference into mutable storage, or a value converted on the way in -- is
 * copied by itself, which is exactly the copy the owning entry's by-value
 * formal made. Refusing the whole entry for it sent every other argument of
 * the call through by-value formals too: one union read from a field cost a
 * copy and release of each handle beside it, and a move of each local.
 *
 * Mixed move/borrow evaluation is still refused, for `stableBorrowEntryAccepts`'s
 * reason: an owning sibling's `std::move` may be evaluated before a copy or a
 * reference of the same slot is taken.
 */
export const stableBorrowEntryCopies = (
  entry: StableBorrowEntry,
  actuals: readonly IrOperand[],
  stable: ReadonlySet<IrValueId>,
  dyingArguments: ReadonlySet<IrValueId>
): ReadonlySet<number> | null => {
  const copies = new Set<number>()
  for (const ordinal of entry.formals) {
    const actual = actuals[ordinal]
    const formal = entry.abi.parameters[ordinal]
    if (!formal) return null
    // An omitted argument is padded with a temporary of the formal's carrier.
    if (!actual) continue
    if (!stable.has(actual.value) || representationKey(actual.representation) !== representationKey(formal.value)) copies.add(ordinal)
  }
  const siblingsStayPut = actuals.every(
    (actual, ordinal) =>
      entry.formals.has(ordinal) ||
      !dyingArguments.has(actual.value) ||
      !(borrowWorthy(actual.representation) || actual.representation.kind === 'dynamic')
  )
  return siblingsStayPut ? copies : null
}

/**
 * Dying argument reads a call hands to a position its callee's borrowed entry
 * takes by reference -- a direct call's, or every arm's of a union dispatch: the entry binds them in place, so they move
 * nothing. Only a call that will enter the entry counts -- one where no other
 * position moves a handle (`stableBorrowEntryCopies`' refusal) -- and only an
 * argument already carried as the formal, since a conversion builds a
 * temporary of its own and the move feeds that.
 */
export const borrowForwardedArgumentsOf = (
  bodies: readonly IrBody[],
  entries: ReadonlyMap<string, StableBorrowEntry>,
  dyingArguments: ReadonlySet<IrValueId>
): ReadonlySet<IrValueId> => {
  const forwarded = new Set<IrValueId>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'call') continue
        const target = operation.target
        const targets =
          target?.kind === 'direct' ? [target.functionId] : target?.kind === 'union-arm' ? target.arms.map((arm) => arm.functionId) : []
        const callees = targets.map((functionId) => entries.get(cppBodyName(functionId)))
        if (callees.length === 0) continue
        // A union dispatch enters one arm's body, so every arm must take the position by reference.
        operation.arguments.forEach((argument, ordinal) => {
          if (!dyingArguments.has(argument.value)) return
          const borrowed = callees.every((entry) => {
            const formal = entry?.abi.parameters[ordinal]
            return (
              entry !== undefined &&
              formal !== undefined &&
              entry.formals.has(ordinal) &&
              representationKey(argument.representation) === representationKey(formal.value) &&
              stableBorrowEntryCopies(entry, operation.arguments, new Set(), dyingArguments) !== null
            )
          })
          if (borrowed) forwarded.add(argument.value)
        })
      }
  return forwarded
}

/** `dying` without `released`, keeping the sunk stores of the reads that remain. */
export const withoutDyingArguments = (dying: ReadonlySet<IrValueId>, released: ReadonlySet<IrValueId>): ReadonlySet<IrValueId> => {
  const kept = new DyingArgumentSet()
  for (const value of dying) if (!released.has(value)) kept.add(value)
  if (dying instanceof DyingArgumentSet)
    for (const [value, store] of dying.sunkStores) if (!released.has(value)) kept.sunkStores.set(value, store)
  return kept
}
