import type { ConversionNode } from './algebra.js'
import { abiOfCallee } from '../projection/callee.js'
import { abiKey, representationKey, type Representation } from '../representation/model.js'

/** An actual declared-any boundary retains its source Function object, independently of frame adaptation or field reflection. */
export const nativeCallableDynamicIdentityTransportMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    return false
  if (node.capability.kind !== 'atom' && node.capability.kind !== 'static') return false
  if (node.capability.materializer.callableIdentityTransport !== 'preserved') return false
  return (source.kind === 'dynamic' && abiOfCallee(target) !== null) || (target.kind === 'dynamic' && abiOfCallee(source) !== null)
}

/** Function identity survives an admitted adapter independently of its executable frame. */
export const nativeCallableIdentityTransportMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    return false
  const from = abiOfCallee(source)
  const to = abiOfCallee(target)
  if (from === null || to === null || (node.capability.kind !== 'atom' && node.capability.kind !== 'static')) return false
  const materializer = node.capability.materializer
  if (materializer.callableIdentityTransport !== 'preserved') return false
  const method = materializer.nativeMethod
  if (method) return abiKey(method.source) === abiKey(from) && abiKey(method.target) === abiKey(to) && method.identity === 'preserved'
  const view = materializer.callableView
  if (view)
    return representationKey(view.source) === representationKey(source) && representationKey(view.target) === representationKey(target)
  const adapter = materializer.callableAdapter
  return adapter !== undefined && abiKey(adapter.from) === abiKey(from) && abiKey(adapter.to) === abiKey(to)
}

/**
 * An exact ordinary frame may enter its source body using the physical receiver
 * or the logical receiver forwarded by a native source-only method entry.
 * @semanticCategory generic-primitive
 */
export type NativeCallableEntryReceiver = 'physical' | 'logical'

export const nativeCallableEntryReceiverOf = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): NativeCallableEntryReceiver | null => {
  if (nativeCallablePrefixAdapterMatches(source, target, node)) return 'physical'
  if (!nativeCallableIdentityTransportMatches(source, target, node)) return null
  if (node!.capability.kind !== 'atom' && node!.capability.kind !== 'static') return null
  const method = node!.capability.materializer.nativeMethod
  if (method === undefined || node!.capability.materializer.nativeFieldProtocol !== 'unused') return null
  const from = method.source
  const to = method.target
  if (
    from.receiver === null ||
    from.restFrom !== null ||
    to.restFrom !== null ||
    from.parameters.length > to.parameters.length ||
    abiKey({ ...from, receiver: to.receiver, parameters: to.parameters.slice(0, from.parameters.length) }) !==
      abiKey({ ...from, receiver: to.receiver }) ||
    representationKey(from.result) !== representationKey(to.result)
  )
    return null
  return 'logical'
}

/** Receiver transport is independent of argument/result reflection or executable body provenance. */
export const nativeCallableLogicalReceiverTransportMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    return false
  const from = abiOfCallee(source)
  const to = abiOfCallee(target)
  if (from === null || to === null) return false
  const capability = node.capability
  if (capability.kind !== 'atom' && capability.kind !== 'static') return false
  const materializer = capability.materializer
  const view = materializer.callableView
  if (view)
    return representationKey(view.source) === representationKey(source) && representationKey(view.target) === representationKey(target)
  const adapter = materializer.callableAdapter
  return (
    materializer.callableIdentityTransport === 'preserved' &&
    adapter !== undefined &&
    abiKey(adapter.from) === abiKey(from) &&
    abiKey(adapter.to) === abiKey(to)
  )
}

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
