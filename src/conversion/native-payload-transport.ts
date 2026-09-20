import type { ConversionNode } from './algebra.js'
import { representationKey, type Representation } from '../representation/model.js'

/** Consume the selected materializer's payload proof. The existence of a
 * different native recipe for this pair cannot certify the installed one.
 *
 * `class-family` joins `atom`/`static` here, not beside them by coincidence:
 * `conversion/build.ts`'s `narrowingCapabilityFor` wraps the IDENTICAL
 * `installed.materializer` a plain narrowing `atom` would get, reaching for
 * `class-family` only because a base handle narrowed to a union of
 * descendants needs the class-table-aware cascade
 * `targets/cpp/emit-narrowing.ts`'s `classFamilyLoadText` renders, not
 * because the runtime proof about the value differs -- `algebra.ts`'s own
 * `transfersNativeStorage` already treats `atom`/`static`/`class-family`
 * identically for exactly this reason. Refusing the capability kind here
 * while accepting it two lines up (for `atom`) meant a class field read back
 * through a narrowing/widening class-family conversion -- a base field typed
 * `Object3D` resolved at one call site to a closed union of its own
 * descendants, or the reverse -- could never be `exact` even when the cited
 * materializer proved the identical non-allocating, field-protocol-free,
 * payload-preserving transfer an `atom` pair proves for the same shape of
 * conversion. The materializer conditions below are UNCHANGED from the
 * `atom`/`static` case; only which `capability.kind` may present one is
 * widened.
 */
export const nativePayloadTransportMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    return false
  const capability = node.capability
  return (
    capability.kind === 'identity' ||
    ((capability.kind === 'atom' || capability.kind === 'static' || capability.kind === 'class-family') &&
      !capability.materializer.allocates &&
      capability.materializer.nativeFieldProtocol === 'unused' &&
      capability.materializer.nativePayloadTransport === 'preserved')
  )
}
