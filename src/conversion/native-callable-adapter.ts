import type { ConversionNode } from './algebra.js'
import { abiOfCallee } from '../projection/callee.js'
import { abiKey, representationKey, type Representation } from '../representation/model.js'

/** A selected native adapter ignores only an added receiver. The ordinary
 * frame is unchanged, so callable provenance may enter the original body
 * with those arguments and no receiver, retaining the same Function identity.
 */
export const nativeReceiverIgnoringCallableAdapterMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    return false
  const from = abiOfCallee(source)
  const to = abiOfCallee(target)
  if (!from || !to || from.receiver !== null || to.receiver === null || abiKey({ ...from, receiver: to.receiver }) !== abiKey(to))
    return false
  const capability = node.capability
  if (capability.kind !== 'atom' && capability.kind !== 'static') return false
  const materializer = capability.materializer
  const adapter = materializer.callableAdapter
  return (
    materializer.nativeFieldProtocol === 'unused' &&
    materializer.callableIdentityTransport === 'preserved' &&
    adapter !== undefined &&
    abiKey(adapter.from) === abiKey(from) &&
    abiKey(adapter.to) === abiKey(to)
  )
}

/** A cited identity-preserving native adapter can also discard a fixed
 * trailing argument suffix. Only the source prefix reaches its body; result
 * and prefix carriers stay identical. Receiver adaptation is licensed by the
 * same selected conversion, never inferred from class spellings here.
 */
export const nativeCallablePrefixAdapterMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    return false
  const from = abiOfCallee(source)
  const to = abiOfCallee(target)
  if (!from || !to || from.restFrom !== null || to.restFrom !== null || from.parameters.length > to.parameters.length) return false
  if (from.receiver !== null && to.receiver === null) return false
  if (
    abiKey({ ...from, receiver: to.receiver, parameters: to.parameters.slice(0, from.parameters.length) }) !==
    abiKey({ ...from, receiver: to.receiver })
  )
    return false
  if (representationKey(from.result) !== representationKey(to.result)) return false
  const capability = node.capability
  if (capability.kind !== 'atom' && capability.kind !== 'static') return false
  const materializer = capability.materializer
  return (
    materializer.nativeFieldProtocol === 'unused' &&
    materializer.callableIdentityTransport === 'preserved' &&
    materializer.callableAdapter !== undefined &&
    abiKey(materializer.callableAdapter.from) === abiKey(from) &&
    abiKey(materializer.callableAdapter.to) === abiKey(to)
  )
}
