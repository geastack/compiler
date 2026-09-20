import type { AbiParameter, CallableAbi, Representation } from './model.js'
import { passingOf, representationKey } from './model.js'
import { optionalOf } from './optional.js'

/**
 * The convention that subsumes every ABI in a host handle's own overload set,
 * when one exists.
 *
 * `derive.ts`'s `sharedAbiOf` requires every overload to share one identical
 * frame, which is correct for an ordinary program-defined callable: a caller
 * reaching one overload through another's frame passes the wrong arguments.
 * A host handle's overload set is commonly shaped differently: TypeScript's
 * own `ErrorConstructor` carries `new(message?: string): Error` from
 * `lib.es5.d.ts` AND `new(message?: string, options?: ErrorOptions): Error`
 * from `lib.es2022.error.d.ts`'s declaration merge, kept side by side rather
 * than replaced. These are not two incompatible frames -- they are one frame
 * with a trailing optional parameter, spelled as two overloads instead of
 * one signature -- so the WIDEST overload's own ABI already accepts every
 * call the narrower ones do: an absent trailing optional argument is exactly
 * what a shorter call site passes. The join is position-wise: at each slot
 * every overload must carry the same representation, except that one may
 * spell it optional (or, past its own length, omit it) where another
 * requires it, and the joined slot is then the optional one; the results
 * must agree, and no overload may have a receiver or a rest parameter. A
 * genuine incompatibility -- a different parameter type at a shared
 * position, not just a different presence -- still refuses: this is a
 * widening test, never a coercion this layer invents.
 *
 * A refusal is returned as the REASON rather than as `null`, because
 * "no primitive joining 4 overload signatures into one calling convention"
 * names a count and not a defect: four different walls read as one family and
 * the next lever cannot be ranked from it. The reason text is deliberately
 * short and free of carrier keys so equal walls group together.
 */
export const widestSubsumingAbi = (abis: readonly CallableAbi[]): CallableAbi | string => {
  const first = abis[0]
  if (!first) return 'the set is empty'
  if (abis.some((abi) => abi.receiver !== null)) return 'an overload declares a receiver'
  if (abis.some((abi) => abi.restFrom !== null)) return 'an overload is variadic'
  const resultKey = representationKey(first.result)
  if (abis.some((abi) => representationKey(abi.result) !== resultKey)) return 'the overloads disagree about the result'
  const length = Math.max(...abis.map((abi) => abi.parameters.length))
  const parameters: AbiParameter[] = []
  for (let position = 0; position < length; position += 1) {
    // The one carrier every overload agrees on at this position, widened to
    // its optional form when any overload spells it optional -- or omits it,
    // since a shorter overload's absent trailing parameter is the same
    // "the caller did not supply it" the optional carrier already holds.
    // `test: (node: Node) => node is TOut` beside `test?: (node: Node) =>
    // boolean` (TypeScript's own `NodeVisitor`) is one slot, not two frames:
    // every call through the set that omits it reaches the value through the
    // optional slot, and every call that passes it fills the same slot.
    let joined: AbiParameter | null = null
    let omitted = false
    for (const abi of abis) {
      const own = abi.parameters[position]
      if (own === undefined) {
        omitted = true
        continue
      }
      if (joined === null || sameCarrier(own.value, joined.value)) {
        joined ??= own
        continue
      }
      if (widensTo(joined.value, own.value)) {
        joined = own
        continue
      }
      if (!widensTo(own.value, joined.value)) return `the overloads disagree at parameter ${position}`
    }
    if (joined === null) return `parameter ${position} is declared by no overload`
    // A position some overload OMITS is optional in the physical sense even
    // where the overload that declares it spells it required. The set is one
    // runtime function and the declaration itself says a call without this
    // argument is legal, so the convention that holds both calls is the
    // widened one -- `realpathSync(path)` beside `realpathSync(path, options)`
    // is node's own spelling of a single entry point, and refusing it left
    // every value read of such a set with no calling convention at all (288
    // rows in tsc's self-compile, concentrated in `sys.ts`, `checker.ts` and
    // `tracing.ts`). Only the ARITY widens: every shared position must already
    // agree, and so must the result, which the checks above enforce.
    if (omitted && joined.value.kind !== 'optional') {
      const widened = optionalOf(joined.value, 'undefined')
      parameters.push(widened === joined.value ? joined : { value: widened, ownership: 'owned', passing: passingOf(widened, 'owned') })
      continue
    }
    parameters.push(joined)
  }
  return { ...first, parameters }
}

const sameCarrier = (left: Representation, right: Representation): boolean => representationKey(left) === representationKey(right)

/** Whether `wider` is exactly `narrower` behind an optional -- the one widening this layer admits. */
const widensTo = (narrower: Representation, wider: Representation): boolean =>
  wider.kind === 'optional' && wider.absence === 'undefined' && sameCarrier(wider.payload, narrower)
