import type { DeclarationId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import {
  arrayPrototypeMethods,
  dataViewPrototypeMethods,
  datePrototypeMethods,
  dictionaryPrototypeMethods,
  declaredStringPrototypeMemberNames,
  errorPrototypeMethods,
  isDateCarrier,
  isNativeError,
  iteratorPrototypeMethods,
  keyedCollectionPrototypeMethods,
  numberPrototypeMethods,
  promisePrototypeMethods,
  stringPrototypeMethods,
  typedArrayPrototypeMethods
} from '../representation/prototype-domains.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import type { ClassLayout } from './classes.js'
import { classMemberOf, declaredRecordFieldOf, recordFieldsOfShape } from './fields.js'
import { regexpDataMemberStorage, regexpPatternMethodKeys, regexpRoleOf } from './regexp-fields.js'
import { hostMemberOf, type HostMemberTable } from '../targets/cpp/host/host-members.js'

/** Object.prototype algorithms with a native fused call entry. */
export const objectShapePrototypeMethods: ReadonlySet<string> = new Set(['hasOwnProperty', 'propertyIsEnumerable'])

/** An inherited reflection algorithm never preempts an authenticated host-owned member of the same name. */
export const nativeHostReflectionMemberOf = (
  members: HostMemberTable,
  intrinsicProtocols: Pick<ReadonlySet<string>, 'has'> | undefined,
  protocol: string,
  member: string
): boolean =>
  objectShapePrototypeMethods.has(member) &&
  intrinsicProtocols?.has(protocol) === true &&
  hostMemberOf(members, protocol, member) === undefined

/** @semanticCategory generic-primitive */
export type NativePrototypeKind =
  | 'array-object'
  | 'typed-array'
  | 'data-view'
  | 'string'
  | 'number'
  | 'bigint'
  | 'regexp'
  | 'promise'
  | 'iterator'
  | 'keyed-collection'
  | 'date'
  | 'native-error'
  | 'dictionary'
  | 'object-shape'
  | 'callable-shape'
  | 'dynamic-object'

/** The native template selected by a direct receiver and a statically known member. */
export const nativePrototypeMethodOf = (carrier: Representation, member: string): NativePrototypeKind | null => {
  if (carrier.kind === 'array-object')
    return carrier.extension?.some((field) => field.key === member) !== true && arrayPrototypeMethods.has(member) ? 'array-object' : null
  if (carrier.kind === 'typed-array') return typedArrayPrototypeMethods.has(member) ? 'typed-array' : null
  if (carrier.kind === 'data-view') return dataViewPrototypeMethods.has(member) ? 'data-view' : null
  if (carrier.kind === 'string') return stringPrototypeMethods.has(member) ? 'string' : null
  if (carrier.kind === 'scalar') {
    if (carrier.domain === 'number' && numberPrototypeMethods.has(member)) return 'number'
    if (carrier.domain === 'bigint' && (member === 'toString' || member === 'valueOf')) return 'bigint'
    return null
  }
  if (carrier.kind === 'promise') return promisePrototypeMethods.has(member) ? 'promise' : null
  if (carrier.kind === 'iterator' || carrier.kind === 'async-generator') return iteratorPrototypeMethods.has(member) ? 'iterator' : null
  if (carrier.kind === 'keyed-collection') return keyedCollectionPrototypeMethods(carrier.family).has(member) ? 'keyed-collection' : null
  if (isDateCarrier(carrier)) return datePrototypeMethods.has(member) ? 'date' : null
  if (isNativeError(carrier)) return errorPrototypeMethods.has(member) ? 'native-error' : null
  const role = regexpRoleOf(carrier)
  if (role === 'pattern') return regexpPatternMethodKeys.has(member) ? 'regexp' : null
  if (role !== null)
    return regexpDataMemberStorage(role, member) === null && canonicalIndexLiteral(member) === null && arrayPrototypeMethods.has(member)
      ? 'array-object'
      : null
  if (carrier.kind === 'dictionary') return dictionaryPrototypeMethods.has(member) ? 'dictionary' : null
  if (isNativeCallableCarrier(carrier.kind)) return objectShapePrototypeMethods.has(member) ? 'callable-shape' : null
  if (carrier.kind === 'dynamic') return member === 'hasOwnProperty' ? 'dynamic-object' : null
  if (carrier.kind === 'record')
    return !carrier.fields.some((field) => field.key === member) &&
      !carrier.accessors.some((accessor) => accessor.key === member) &&
      objectShapePrototypeMethods.has(member)
      ? 'object-shape'
      : null
  return null
}

export const nativePrototypeShapeMethodOf = (
  carrier: Representation,
  member: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): boolean => {
  if (!objectShapePrototypeMethods.has(member)) return false
  if (carrier.kind === 'record') return nativePrototypeMethodOf(carrier, member) === 'object-shape'
  if (carrier.kind !== 'class-ref' && !(carrier.kind === 'native-record-ref' && carrier.native === null)) return false
  if (carrier.kind === 'class-ref' && classMemberOf(classes, carrier.declaration, member) !== null) return false
  return declaredRecordFieldOf(deriver, carrier, member, classes) === null && recordFieldsOfShape(deriver, carrier.shapeId) !== null
}

const symbolPrototypeCallableMembers: ReadonlySet<string> = new Set(['toString', 'valueOf', 'constructor'])

/** A positive callable facet, including native handles and aliases; unknown carriers cannot prove a TypeError. */
export const prototypeEntryMayBeCallable = (representation: Representation): boolean => {
  if (representation.kind === 'tagged-union') return representation.arms.some((arm) => prototypeEntryMayBeCallable(arm.value))
  if (representation.kind === 'optional') return prototypeEntryMayBeCallable(representation.payload)
  if (representation.kind === 'borrowed-ref') return prototypeEntryMayBeCallable(representation.referent)
  if (representation.kind === 'proxy-object') return prototypeEntryMayBeCallable(representation.target)
  if (representation.kind === 'native-handle') return representation.call !== null
  if (isNativeCallableCarrier(representation.kind)) return true
  switch (representation.kind) {
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'undefined':
    case 'null':
    case 'void':
    case 'array-object':
    case 'dictionary':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'keyed-collection':
    case 'record':
    case 'record-with-index':
      return false
    case 'native-record-ref':
      return representation.native !== null
    default:
      return true
  }
}

/** Only a native property domain that positively excludes a callable can license a noncallable sum arm. */
export const prototypeArmHasNoCallableMember = (arm: Representation, member: string): boolean => {
  if (objectPrototypeMemberNames.has(member)) return false
  if (arm.kind === 'string') return !declaredStringPrototypeMemberNames.has(member)
  if (arm.kind === 'symbol') return !symbolPrototypeCallableMembers.has(member)
  if (arm.kind === 'dictionary') return arm.key === 'number' || !prototypeEntryMayBeCallable(arm.value)
  return false
}

/** A complete per-arm template claim, with at least one builtin and only proven noncallable alternatives. */
export const mixedPrototypeCallArmsOf = <T>(
  carrier: Representation,
  member: string,
  claim: (arm: Representation) => T | null
): readonly (T | null)[] | null => {
  if (carrier.kind !== 'tagged-union') return null
  const arms: (T | null)[] = []
  let answered = false
  for (const arm of carrier.arms) {
    const selected = claim(arm.value)
    if (selected !== null) {
      arms.push(selected)
      answered = true
    } else {
      if (!prototypeArmHasNoCallableMember(arm.value, member)) return null
      arms.push(null)
    }
  }
  return answered ? arms : null
}

/** The same exact member domains used by finalized native prototype Gets, before source call slots are selected. */
export const nativePrototypeTemplateOf = (
  carrier: Representation,
  member: string,
  deriver: RepresentationDeriver,
  classes?: ReadonlyMap<DeclarationId, ClassLayout>
): boolean => {
  if (carrier.kind === 'optional') return nativePrototypeTemplateOf(carrier.payload, member, deriver, classes)
  if (carrier.kind === 'borrowed-ref') return nativePrototypeTemplateOf(carrier.referent, member, deriver, classes)
  if (carrier.kind === 'tagged-union')
    return (
      mixedPrototypeCallArmsOf(carrier, member, (arm) => (nativePrototypeTemplateOf(arm, member, deriver, classes) ? true : null)) !== null
    )
  if (nativePrototypeMethodOf(carrier, member) !== null) return true
  if (classes !== undefined && nativePrototypeShapeMethodOf(carrier, member, classes, deriver)) return true
  if (carrier.kind === 'class-ref' && classes !== undefined && classMemberOf(classes, carrier.declaration, member) === null) {
    const native = carrier.nativeBase
    if (native?.kind === 'promise' || native?.kind === 'keyed-collection')
      return nativePrototypeTemplateOf(native, member, deriver, classes)
  }
  return false
}
