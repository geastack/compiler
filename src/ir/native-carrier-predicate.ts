import type { Representation } from '../representation/model.js'
import type { IrOperation } from './model.js'

/**
 * A call that reads its argument's CARRIER and nothing inside it.
 *
 * `Array.isArray(v)` -- ECMA-262 23.1.2.2 -- answers whether the value is an
 * Array exotic object. It reads no property, runs no getter, invokes no
 * method: nothing about the argument's contents can be observed through it.
 * So an argument passed to one is not exposed to the dynamic protocol, and a
 * class or record reaching one keeps its native field surface.
 *
 * Without this the reflection census saw an ordinary call whose ambient
 * parameter is `any`, concluded it "may inspect or mutate every native
 * receiver/argument", and gave every class reachable through the argument the
 * full boxed reflection protocol -- `gea_readOwnField`, `gea_ownFieldDescriptor`
 * and the `gea::Value::box` calls inside them. The printer had already decided
 * otherwise: `emit-host-invoke.ts`'s `isArrayText` renders the whole call as
 * the argument's own discriminant (`v.is<0>() ? false : true`), so the call it
 * emits reads exactly the tag. Two authorities disagreed about one call, and
 * the census's answer -- the pessimistic one -- shaped the emitted struct.
 *
 * The authentication is the semantic layer's, not this file's: the same guards
 * that authenticate `Object.keys` (`producers/invocations.ts`'s
 * `intrinsicPropertyCallOf` -- standard-library provenance for both the owner
 * and the member, no global host-mutation taint) stamp
 * `intrinsicCarrierPredicate`, and this reads that fact. That is the
 * `intrinsicOwnKeys`/`nativeKeyQueryOf` arrangement exactly.
 *
 * A `proxy-object` argument is excluded. `IsArray` walks a proxy to its target
 * rather than invoking a trap, so the exclusion is not required by the spec --
 * it is here because `native-key-query.ts` draws the same line for the same
 * reason, and a carrier whose behaviour is another object's is not one this
 * claim should be the first to speak for.
 */
export const nativeCarrierPredicateOf = (operation: IrOperation): boolean => {
  if (operation.kind !== 'call' || !operation.intrinsicCarrierPredicate || operation.argumentsAreSpread) return false
  const queried = operation.arguments[0]?.representation
  if (queried === undefined || operation.arguments.length !== 1) return false
  const carrierOnly = (value: Representation): boolean => {
    if (value.kind === 'optional') return carrierOnly(value.payload)
    if (value.kind === 'borrowed-ref') return carrierOnly(value.referent)
    if (value.kind === 'tagged-union') return value.arms.length > 0 && value.arms.every((arm) => carrierOnly(arm.value))
    return value.kind !== 'proxy-object'
  }
  return carrierOnly(queried)
}
