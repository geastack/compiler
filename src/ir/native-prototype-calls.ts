import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMemberOf } from '../projection/fields.js'
import { regexpRoleOf } from '../projection/regexp-fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import { nativePrototypeMethodOf, nativePrototypeShapeMethodOf, type NativePrototypeKind } from '../projection/native-prototype-methods.js'
export { nativePrototypeMethodOf, nativePrototypeShapeMethodOf } from '../projection/native-prototype-methods.js'
export type { NativePrototypeKind } from '../projection/native-prototype-methods.js'
import type { CallOperation, IrOperation } from './model.js'

export interface NativePrototypeCallClaim {
  readonly kind: NativePrototypeKind
  readonly carrier: Representation
  readonly member: string
  readonly nativeReceiver?: Representation
}

/**
 * A fused call enters a prototype's native template, not the ambient callable
 * signature. The exact Get and constant key authenticate which template it is.
 */
export const nativePrototypeCallClaimsOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver?: RepresentationDeriver
): readonly NativePrototypeCallClaim[] | null => {
  const read = definitionOf(operation.callee.value)
  if (read?.kind !== 'get' || read.hostMethod !== undefined) return null
  const key = definitionOf(read.key.value)
  if (key?.kind !== 'constant' || key.literal !== 'string') return null
  const member = key.text
  const claims = (carrier: Representation): readonly NativePrototypeCallClaim[] | null => {
    if (carrier.kind === 'undefined' || carrier.kind === 'null') return []
    if (carrier.kind === 'optional') return claims(carrier.payload)
    if (carrier.kind === 'tagged-union') {
      const result: NativePrototypeCallClaim[] = []
      for (const arm of carrier.arms) {
        const branch = claims(arm.value)
        if (branch === null) return null
        result.push(...branch)
      }
      return result
    }
    if (carrier.kind === 'class-ref') {
      if (classMemberOf(classes, carrier.declaration, member) !== null) return null
      if (carrier.nativeBase?.kind === 'promise' || carrier.nativeBase?.kind === 'keyed-collection')
        return claims(carrier.nativeBase)?.map((claim) => ({ ...claim, nativeReceiver: carrier })) ?? null
      if (deriver && nativePrototypeShapeMethodOf(carrier, member, classes, deriver)) return [{ kind: 'object-shape', carrier, member }]
      return null
    }
    if (deriver && nativePrototypeShapeMethodOf(carrier, member, classes, deriver)) return [{ kind: 'object-shape', carrier, member }]
    const kind = nativePrototypeMethodOf(carrier, member)
    if (kind === null) return null
    if (kind === 'array-object' && regexpRoleOf(carrier) !== null)
      return [
        { kind, carrier: { kind: 'array-object', element: { kind: 'string' }, ownership: 'shared-refcount', extension: null }, member }
      ]
    return [{ kind, carrier, member }]
  }
  return claims(read.receiver.representation)
}
