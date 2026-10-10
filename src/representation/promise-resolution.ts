import { representationKey, type Representation } from './model.js'
import { optionalOf } from './optional.js'

/**
 * What `awaitedText` resolves a carrier TO -- the carrier's `Awaited<T>`.
 *
 * Stated beside the render rather than derived by a caller, so the two cannot
 * disagree about which arms survive. A union of promises over one payload
 * resolves to that payload; a union mixing a payload with a promise of the
 * same payload resolves to the payload as well, which is the ordinary case.
 * `null` when the arms do not agree, which is a real hole rather than a
 * missing recipe: `string | Promise<number>` resolves to `string | number`,
 * a union this cannot mint without the census's own arm ordering.
 */
export const awaitedRepresentation = (carrier: Representation): Representation | null => {
  if (carrier.kind === 'promise') return carrier.value
  // An absence survives the resolution -- `PromiseResolve(undefined)` is
  // `undefined` -- so the wrapper is kept over whatever the payload resolves
  // to. Through `optionalOf` rather than a literal wrapper because the payload
  // may already carry its own absence (a refcounted instance, a handle, a box,
  // or a second optional), and stacking a flag onto one of those is the carrier
  // the census forbids rather than a type this backend can spell.
  if (carrier.kind === 'optional') {
    const payload = awaitedRepresentation(carrier.payload)
    return payload === null ? null : optionalOf(payload, carrier.absence)
  }
  if (carrier.kind === 'class-ref' && carrier.nativeBase?.kind === 'promise') return carrier.nativeBase.value
  if (carrier.kind !== 'tagged-union') return carrier
  const resolved = carrier.arms.map((arm) =>
    arm.value.kind === 'promise'
      ? arm.value.value
      : arm.value.kind === 'class-ref' && arm.value.nativeBase?.kind === 'promise'
        ? arm.value.nativeBase.value
        : arm.value
  )
  const [first, ...rest] = resolved
  if (!first) return null
  return rest.every((entry) => representationKey(entry) === representationKey(first)) ? first : null
}

/** A native inherited Promise may be adopted only when no override is bypassed. */
export const nativePromiseBaseOf = (source: Representation): Extract<Representation, { kind: 'promise' }> | null =>
  source.kind === 'class-ref' && source.nativeBase?.kind === 'promise' && source.nativeBaseOverridden !== true ? source.nativeBase : null

/** Whether PromiseResolve has an adoption branch for this carrier. */
export const holdsThenable = (carrier: Representation): boolean => {
  if (carrier.kind === 'promise' || (carrier.kind === 'class-ref' && carrier.nativeBase?.kind === 'promise') || carrier.kind === 'dynamic')
    return true
  if (carrier.kind === 'optional') return holdsThenable(carrier.payload)
  return carrier.kind === 'tagged-union' && carrier.arms.some((arm) => holdsThenable(arm.value))
}
