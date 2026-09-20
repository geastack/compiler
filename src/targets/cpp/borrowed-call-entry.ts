import type { FunctionId, IrValueId } from '../../identity/ids.js'
import { readonlyBorrowFormalsOf, type PrivateBorrowCell } from '../../ir/borrowed-call-arguments.js'
import type { IrBody, IrOperand } from '../../ir/model.js'
import { passingOf, representationKey, type CallableAbi } from '../../representation/model.js'
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
  bodyCallsUnsafeKnownCallee: boolean,
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
  // A body that calls a RESOLVABLE callee never proven effect-safe can have
  // that callee write through one of this body's own other parameters --
  // `snapshot(text, holder) { middle(holder); return text }`, where `middle`
  // writes `holder.text`. `readonlyBorrowFormalsOf` looks at binding writes
  // only and cannot see a transitive one, so the disqualification is asked
  // here, of the whole-program fact that already knows the call graph.
  //
  // Deliberately restricted to a KNOWN callee. An opaque one -- a callback
  // arriving as a parameter value, with no resolvable target -- is a hazard
  // for the CALLER to rule out against the actual it supplies
  // (`stableBorrowEntryAccepts` below), and disqualifying the entry here
  // instead would withdraw the fast path from every higher-order body whose
  // callers can prove their actuals stable.
  if (bodyCallsUnsafeKnownCallee) return null
  const readonly = readonlyBorrowFormalsOf(body, privateCell, dyingArguments)
  const formals = new Set([...readonly].filter((ordinal) => abi.parameters[ordinal]?.passing === 'const-ref'))
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
    (actual, ordinal) => entry.formals.has(ordinal) || !dyingArguments.has(actual.value) || passingOf(actual.representation) !== 'const-ref'
  )
}
