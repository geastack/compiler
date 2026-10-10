import type { DeclarationId } from '../../identity/ids.js'
import { abiKey, representationKey, type Representation } from '../../representation/model.js'

/** Native inheritance conversions change a handle's view, never its payload
 * or property protocol. Shared by conversion selection and callable adapters. */
export const classRefTransportKind = (source: Representation, target: Representation): 'same' | 'upcast' | 'downcast' | null => {
  if (source.kind !== 'class-ref' || target.kind !== 'class-ref' || source.ownership !== target.ownership) return null
  if (source.declaration === target.declaration && source.shapeId === target.shapeId) return 'same'
  if (source.ancestors.includes(target.declaration)) return 'upcast'
  if (target.ancestors.includes(source.declaration)) return 'downcast'
  return null
}

/**
 * The same two directions between a class and the native RECORD its struct
 * derives from in place (`class-ref.nativeBase` -- the intrinsic `Error`).
 * `Ref<Derived>` to `Ref<gea::runtime::Error>` is the pointer upcast, refused
 * for a family that answers one of the error's own members differently
 * (`nativeBaseOverridden`): held as the bare error, the override would be
 * skipped. The downcast is the checked narrowing an `instanceof` licenses,
 * which no override affects -- the value read back IS the class instance.
 */
export const nativeRecordBaseTransportKind = (source: Representation, target: Representation): 'upcast' | 'downcast' | null => {
  if (
    source.kind === 'class-ref' &&
    target.kind === 'native-record-ref' &&
    source.nativeBase?.kind === 'native-record-ref' &&
    source.nativeBaseOverridden !== true &&
    source.ownership === target.ownership &&
    representationKey(source.nativeBase) === representationKey(target)
  )
    return 'upcast'
  if (
    source.kind === 'native-record-ref' &&
    target.kind === 'class-ref' &&
    target.nativeBase?.kind === 'native-record-ref' &&
    source.ownership === target.ownership &&
    representationKey(target.nativeBase) === representationKey(source)
  )
    return 'downcast'
  return null
}

export { nativePromiseBaseOf } from '../../representation/promise-resolution.js'

/**
 * A single-class constructor family stored into a family that also names that
 * class, with the same frame except a result upcast to the target's class.
 * Only a one-member source: the rendering names the member's construct thunk,
 * and a family of several has no one thunk to name.
 */
/**
 * A constructor family of SEVERAL classes stored into a wider family whose
 * result is a base of the source's (`override RESPONSE_TYPE = ListResponse`,
 * a `typeof ListResponse` family that also names `ExplainedListResponse`,
 * landing in the base's `typeof BaseResponse` slot). No one thunk names the
 * source, so the rendering recognizes which member's construct pointer the
 * value carries and installs that member's thunk upcast to the target result
 * (`gea::upcastConstructorFamily`); a value built any other way is refused at
 * run time by name.
 */
export const constructorFamilyUpcastMembers = (source: Representation, target: Representation): readonly DeclarationId[] | null => {
  if (source.kind !== 'constructor-family' || target.kind !== 'constructor-family') return null
  if (source.members.length < 2 || !source.members.every((member) => target.members.includes(member))) return null
  if (classRefTransportKind(source.abi.result, target.abi.result) !== 'upcast') return null
  if (abiKey({ ...source.abi, result: target.abi.result }) !== abiKey(target.abi)) return null
  return source.members
}

export const constructorUpcastMember = (source: Representation, target: Representation): DeclarationId | null => {
  if (source.kind !== 'constructor-family' || target.kind !== 'constructor-family') return null
  const [member] = source.members
  if (member === undefined || source.members.length !== 1 || !target.members.includes(member)) return null
  if (classRefTransportKind(source.abi.result, target.abi.result) !== 'upcast') return null
  if (abiKey({ ...source.abi, result: target.abi.result }) !== abiKey(target.abi)) return null
  return member
}
