import { canonicalIndexLiteral } from '../representation/array-index.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrOperation } from './model.js'

/**
 * Native array transport does not publish the fields of its elements. This
 * proves absence of reflection effects, not admission of an array operation:
 * lowering and conversion guards still own whether it can be performed.
 */
export const nativeArrayTransportOf = (operation: IrOperation, constantKey: string | null): boolean => {
  if (operation.kind === 'allocate-array-object') {
    const target = operation.result.representation
    if (target.kind !== 'array-object' || target.ownership !== 'shared-refcount') return false
    const element = representationKey(target.element)
    return operation.elements.every((slot) => {
      if (slot.kind === 'hole') return true
      if (slot.kind === 'element') return representationKey(slot.value.representation) === element
      if (slot.kind !== 'spread' || slot.element !== undefined) return false
      const source = slot.value.representation
      return source.kind === 'array-object' && representationKey(source.element) === element
    })
  }
  if (operation.kind !== 'get' && operation.kind !== 'set') return false
  const receiver = operation.receiver.representation
  if (receiver.kind === 'tagged-union') return unionIndexReadOf(operation, receiver, constantKey)
  if (receiver.kind !== 'array-object') return false
  const value = operation.kind === 'get' ? operation.result.representation : operation.value.representation
  if (constantKey === 'length') return value.kind === 'scalar' && value.domain === 'number'
  // A constant key can name an ordinary property or method; only a canonical
  // index enters this path. A runtime STRING key is rendered as an element
  // access through CanonicalNumericIndexString (`arrayIndexFromKeyText` in
  // `emit-carrier-members.ts`/`emit-properties.ts`) -- the `for (const i in
  // array)` key hono's RegExpRouter indexes back with -- so it reaches no
  // field protocol either.
  const indexed =
    constantKey !== null
      ? canonicalIndexLiteral(constantKey) !== null
      : (operation.key.representation.kind === 'scalar' && operation.key.representation.domain === 'number') ||
        operation.key.representation.kind === 'string'
  if (!indexed) return false
  const element = representationKey(receiver.element)
  if (representationKey(value) === element) return true
  // A checked indexed read represents a hole/out-of-bounds access separately
  // from its existing native payload. It does not adapt or expose that payload.
  return (
    operation.kind === 'get' && value.kind === 'optional' && value.absence === 'undefined' && representationKey(value.payload) === element
  )
}

/**
 * A numeric index read off a union whose every arm is an Array reads each
 * arm's own element storage, exactly as the single-Array read above does, and
 * injects it into the result's arm for that element: no field protocol, no
 * adaptation. Hono's `compose` reads `middleware[i]` off
 * `[[Function, unknown], unknown][] | [[Function]][]`; as a computed key it
 * published every handler tuple the router holds.
 */
const unionIndexReadOf = (
  operation: Extract<IrOperation, { readonly kind: 'get' | 'set' }>,
  receiver: Extract<Representation, { readonly kind: 'tagged-union' }>,
  constantKey: string | null
): boolean => {
  if (operation.kind !== 'get') return false
  const indexed =
    constantKey !== null
      ? canonicalIndexLiteral(constantKey) !== null
      : operation.key.representation.kind === 'scalar' && operation.key.representation.domain === 'number'
  if (!indexed || receiver.arms.length === 0) return false
  const elements: string[] = []
  for (const arm of receiver.arms) {
    if (arm.value.kind !== 'array-object') return false
    elements.push(representationKey(arm.value.element))
  }
  const value = operation.result.representation
  const present = value.kind === 'optional' && value.absence === 'undefined' ? value.payload : value
  const carried = new Set(
    present.kind === 'tagged-union' ? present.arms.map((arm) => representationKey(arm.value)) : [representationKey(present)]
  )
  return elements.every((element) => carried.has(element))
}
