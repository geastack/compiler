import type { Representation } from '../../representation/model.js'

/**
 * The carrier vocabulary of the `v instanceof C` key (ECMA-262 13.10.2), whose
 * IR-side spelling is `ir/certify/property-access.ts`'s `instanceofRuntimeHelperKey`.
 *
 * Keyed by BOTH operands, for the same reason `typeof` is keyed by its
 * operand and `in` by both of its own (`has-property-key.ts`): the operator is always the word `instanceof`, so
 * spelling it says nothing, while what decides whether a backend can answer is
 * what the two sides carry. A boxed value against a host `Error` constructor
 * is a real runtime question this backend answers; the same value against a
 * program's own class is a prototype walk nothing here has written. One flat
 * `computation:instanceof:instanceof` key claimed both at once, which is
 * exactly the over-claim a manifest row must not make -- the program certifies
 * and is then refused at emission.
 *
 * The right half names the host PROTOCOL rather than its carrier kind.
 * `native-handle` alone would merge `Error` with `Math` and with every other
 * bound protocol into one claim, and the protocol is what decides the answer:
 * `gea::host::instanceOfError` (gea_runtime.h) is written for the seven error
 * constructors and for nothing else.
 */
/** A carrier that cannot possibly hold an ECMAScript object. */
export const definitelyPrimitive = (representation: Representation): boolean =>
  representation.kind === 'scalar' ||
  representation.kind === 'string' ||
  representation.kind === 'symbol' ||
  representation.kind === 'null' ||
  representation.kind === 'undefined'

export const mapTestable = (representation: Representation): boolean => {
  if (representation.kind === 'unresolved' || representation.kind === 'borrowed-ref') return false
  if (representation.kind === 'optional') return mapTestable(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => mapTestable(arm.value))
  return true
}
