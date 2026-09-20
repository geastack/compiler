import type { DeclarationId, FunctionId } from '../identity/ids.js'
import { functionId } from '../identity/ids.js'
import type { CallableAbi } from '../representation/model.js'
import { abiKey } from '../representation/model.js'

/**
 * Publishing an extra calling convention for a declaration that already has
 * one.
 *
 * An ordinary function's calling convention is derived, not stated: the plan
 * selects a carrier for its `function-object` allocation, and `projectAbis`
 * (`projection/abi.ts`) reads that carrier back as the one true ABI for the
 * one identity `functionId` mints from its declaration. That is correct for
 * every convention the program itself wrote, and it is exactly why it cannot
 * be the whole answer: nothing in a checked program is obligated to write
 * every convention a caller of this compiler might need. Something composing
 * this compiler into a larger tool may know -- from information this compiler
 * has no way to see, because it is not TypeScript -- that a given declaration
 * is also reachable through one or more *additional* conventions the checked
 * source never spells out. This compiler cannot derive such a convention
 * (there is nothing in the program to derive it from), cannot name why it
 * exists (that reason lives entirely outside a checked program), and must not
 * guess at one either -- so it does neither. It only does the one part that
 * is genuinely generic: given a convention already built by the caller, key
 * it so it is addressable, stable across runs, and never confusable with the
 * declaration's own ordinary convention or with a different caller's.
 *
 * That is the whole of this file. It has no notion of what an extra
 * convention is *for*, does not decide which declarations get one, and does
 * not build one from a declaration's shape -- all three are the caller's
 * business, supplied as data (a `DeclarationId`, a `discriminator`, and an
 * already-built `CallableAbi`) rather than inferred here. Nothing here is
 * called during an ordinary compilation; it exists to be called by whichever
 * later caller has that information, unconditionally on it, if any ever does.
 */

/** Escapes this identity's own field separator, exactly as `identity/ids.ts`'s own (unexported) `encode` does. */
const encode = (part: string): string => part.replace(/[|]/g, '%7C')

/**
 * The identity of one extra calling convention over `declaration`.
 *
 * `identity/ids.ts` mints every real `FunctionId` from a declaration alone
 * (`functionId`), because an ordinary function has exactly one: the
 * convention its own parameter list states. An extra convention is not that
 * function -- calling it with the ordinary convention's frame would read
 * arguments nobody pushed -- so it needs its own identity, and this compiler
 * has no declaration to mint one from: nothing in the checked program is the
 * extra convention. What it does have is the declaration the convention is
 * *about*, which is real and already sealed, plus whatever the caller uses to
 * tell two extra conventions on one declaration apart. Keying on both is what
 * makes the result stable (the same inputs always mint the same identity),
 * reproducible (any later reader with the same two facts can recompute it
 * independently), and collision-free with the declaration's own convention:
 * `functionId(declaration)` alone is never a valid identity here, because
 * `synthesizedFunctionId` always appends a field after it, and an ordinary
 * `FunctionId` never has one.
 *
 * Built from a file path, a source position, or generated text, this would
 * silently change identity every time the program was reformatted or a
 * function moved in the file -- the exact failure this compiler's identity
 * scheme (`identity/ids.ts`'s own module comment) exists to rule out
 * everywhere else. `declaration` and `discriminator` are the only two inputs
 * to guarantee that outcome cannot happen here either.
 */
export const synthesizedFunctionId = (declaration: DeclarationId, discriminator: string): FunctionId =>
  `${functionId(declaration)}|${encode(discriminator)}` as FunctionId

/** One caller-supplied statement: "this declaration also has this convention, distinguished by this discriminator". */
export interface SynthesizedAbiRequest {
  readonly declaration: DeclarationId
  /** Distinguishes two extra conventions the caller wants on the same declaration; opaque to this file. */
  readonly discriminator: string
  readonly abi: CallableAbi
}

/** Two requests named the same declaration and discriminator but disagreed about the convention. */
export interface SynthesizedAbiConflict {
  readonly declaration: DeclarationId
  readonly discriminator: string
  readonly reason: string
}

export interface SynthesizedAbiProjection {
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly conflicts: readonly SynthesizedAbiConflict[]
}

/**
 * Keys every request by its identity and publishes the map.
 *
 * A repeated `(declaration, discriminator)` pair is not an error by itself --
 * two callers, or one caller building its request list twice, may legitimately
 * agree -- so it is accepted silently when the two `CallableAbi`s are the same
 * convention (`abiKey` equal). Two *different* conventions asking to be the
 * same identity is the one case this must not let through in silence: the
 * `FunctionId` the map ends up publishing for that identity would depend on
 * request order, which is exactly the "one operation, one authoritative
 * result" invariant every other publication step in this compiler enforces,
 * so a conflict is reported here rather than resolved by whichever request
 * happened to run last.
 */
export const projectSynthesizedAbis = (requests: readonly SynthesizedAbiRequest[]): SynthesizedAbiProjection => {
  const abis = new Map<FunctionId, CallableAbi>()
  const conflicts: SynthesizedAbiConflict[] = []
  for (const request of requests) {
    const id = synthesizedFunctionId(request.declaration, request.discriminator)
    const existing = abis.get(id)
    if (existing && abiKey(existing) !== abiKey(request.abi)) {
      conflicts.push({
        declaration: request.declaration,
        discriminator: request.discriminator,
        reason:
          `two requests name declaration ${request.declaration} under discriminator "${request.discriminator}" with different ` +
          `calling conventions: "${abiKey(existing)}" and "${abiKey(request.abi)}"`
      })
      continue
    }
    abis.set(id, request.abi)
  }
  return { abis, conflicts: Object.freeze(conflicts) }
}
