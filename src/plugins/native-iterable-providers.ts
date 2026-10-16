import { templateArity, type HostMember } from '../targets/cpp/host/host-members.js'

/** Installed host metadata, not source integrity or an iteration certificate. */
export interface NativeIterableProvider {
  readonly protocol: 'host-sync-iterable@1'
  readonly receiverNative: string
  readonly iteratorFactory: Extract<HostMember, { readonly kind: 'method' }>
  /** No source override can be admitted merely from a readonly declaration. */
  readonly memberModel: 'native-fixed-member'
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Decode only the existing zero-argument native method ABI. A valid provider
 * still needs the exact declared iterator return and an independent source
 * member-integrity proof before normalization may publish an iterable recipe.
 */
export const readNativeIterableProviders = (input: unknown): ReadonlyMap<string, NativeIterableProvider> => {
  if (!(input instanceof Map)) throw new Error('nativeIterableProviders must be a Map')
  const result = new Map<string, NativeIterableProvider>()
  for (const [key, value] of input as Map<unknown, unknown>) {
    if (!nonempty(key) || !record(value)) throw new Error('invalid native iterable provider')
    if (value['protocol'] !== 'host-sync-iterable@1' || value['receiverNative'] !== key || value['memberModel'] !== 'native-fixed-member')
      throw new Error('invalid native iterable provider identity')
    const factory = value['iteratorFactory']
    if (
      !record(factory) ||
      factory['kind'] !== 'method' ||
      factory['arity'] !== 0 ||
      !nonempty(factory['emit']) ||
      factory['result'] !== undefined ||
      (factory['receiver'] !== undefined && factory['receiver'] !== 'host') ||
      (nonempty(factory['emit']) && templateArity(factory['emit']) !== 0)
    )
      throw new Error('native iterable factory requires the typed zero-argument host method ABI')
    // Preserve only fields whose ABI was validated here. Additional source
    // fields cannot smuggle a dynamic result or a different receiver route.
    result.set(key, {
      protocol: 'host-sync-iterable@1',
      receiverNative: key,
      memberModel: 'native-fixed-member',
      iteratorFactory: { kind: 'method', arity: 0, emit: factory['emit'] }
    })
  }
  return result
}

/** A native carrier has one factory authority; conflicting plugin owners refuse. */
export const mergeNativeIterableProviders = (
  inputs: readonly (ReadonlyMap<string, NativeIterableProvider> | undefined)[]
): ReadonlyMap<string, NativeIterableProvider> => {
  const merged = new Map<string, NativeIterableProvider>()
  for (const input of inputs) {
    if (input === undefined) continue
    for (const [key, value] of readNativeIterableProviders(input)) {
      const previous = merged.get(key)
      if (previous && previous.iteratorFactory.emit !== value.iteratorFactory.emit)
        throw new Error('conflicting native iterable factory authorities')
      merged.set(key, value)
    }
  }
  return merged
}
