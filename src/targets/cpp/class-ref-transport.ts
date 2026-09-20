import type { DeclarationId } from '../../identity/ids.js'
import { abiKey, type Representation } from '../../representation/model.js'

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
 * A single-class constructor family stored into a family that also names that
 * class, with the same frame except a result upcast to the target's class.
 * Only a one-member source: the rendering names the member's construct thunk,
 * and a family of several has no one thunk to name.
 */
export const constructorUpcastMember = (source: Representation, target: Representation): DeclarationId | null => {
  if (source.kind !== 'constructor-family' || target.kind !== 'constructor-family') return null
  const [member] = source.members
  if (member === undefined || source.members.length !== 1 || !target.members.includes(member)) return null
  if (classRefTransportKind(source.abi.result, target.abi.result) !== 'upcast') return null
  if (abiKey({ ...source.abi, result: target.abi.result }) !== abiKey(target.abi)) return null
  return member
}
