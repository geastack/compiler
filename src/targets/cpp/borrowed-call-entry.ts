import type { FunctionId, IrValueId } from '../../identity/ids.js'
import { borrowWorthy, dynamicFormalIsReadOnly, readonlyBorrowFormalsOf, type PrivateBorrowCell } from '../../ir/borrowed-call-arguments.js'
import type { IrBody, IrOperand } from '../../ir/model.js'
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
    readonly unchangedNumericAbi: boolean
  }
): StableBorrowEntry | null => {
  const abi = body.abi
  if (
    body.sourceOwner !== owner ||
    !admission.captureFree ||
    !admission.synchronous ||
    !admission.singleBody ||
    !admission.unchangedNumericAbi
  )
    return null
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
  return { owner, name: `${cppBodyName(owner)}_stable_borrow`, abi, formals }
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
