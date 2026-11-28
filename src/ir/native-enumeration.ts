import type { Representation } from '../representation/model.js'

export type NativeEnumerationPlan =
  | { readonly kind: 'empty' }
  | { readonly kind: 'fields' }
  | { readonly kind: 'optional'; readonly present: NativeEnumerationPlan }
  | { readonly kind: 'union'; readonly arms: readonly NativeEnumerationPlan[] }

/** Enumerate native field metadata without reading or boxing field values. */
export const nativeEnumerationPlanOf = (source: Representation): NativeEnumerationPlan | null => {
  switch (source.kind) {
    case 'null':
    case 'undefined':
      return { kind: 'empty' }
    case 'optional': {
      const present = nativeEnumerationPlanOf(source.payload)
      return present ? { kind: 'optional', present } : null
    }
    case 'tagged-union': {
      // Built element by element: an `every` type predicate does not retype the array natively.
      const arms: NativeEnumerationPlan[] = []
      for (const arm of source.arms) {
        const plan = nativeEnumerationPlanOf(arm.value)
        if (plan === null) return null
        arms.push(plan)
      }
      return arms.length > 0 ? { kind: 'union', arms } : null
    }
    // Compiler-rendered records and classes share the native field-key protocol.
    case 'native-record-ref':
    case 'record':
    case 'record-with-index':
    case 'class-ref':
      return source.ownership === 'shared-refcount' && (source.kind !== 'native-record-ref' || source.native === null)
        ? { kind: 'fields' }
        : null
    default:
      return null
  }
}
