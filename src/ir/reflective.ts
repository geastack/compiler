/**
 * `#reflective`: helpers that inspect objects through their runtime shape --
 * prototypes, property descriptors, a generic JSON walk. The JavaScript
 * compiler has that shape; a natively compiled one holds statically typed
 * carriers with no prototype slot or descriptor table, so it maps this
 * module to `reflective-native.ts`.
 */

/**
 * The fields of a plain data object, in order, when each is an ordinary
 * primitive data property and `domain` holds the domain given; else `null`.
 * The domain's own slot keeps its position and is filled in on rebuild.
 */
export const plainFieldsOf = (value: object, domain: string): readonly (readonly [string, unknown])[] | null => {
  if (Object.getPrototypeOf(value) !== Object.prototype) return null
  const fields: (readonly [string, unknown])[] = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property === undefined || !('value' in property) || !property.writable || !property.enumerable || !property.configurable)
      return null
    if (key === 'domain') {
      if (property.value !== domain) return null
      fields.push([key, undefined])
      continue
    }
    const field: unknown = property.value
    if (field !== null && (typeof field === 'object' || typeof field === 'function')) return null
    fields.push([key, field])
  }
  return fields.some(([key]) => key === 'domain') ? fields : null
}
