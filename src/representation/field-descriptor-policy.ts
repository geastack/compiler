import type { Representation } from './model.js'

/**
 * The source-level absence admissions a native dynamic-field descriptor
 * adapter must preserve. A native Optional has one absence bit, so an outer
 * Optional around another absence-bearing carrier is deliberately unsupported
 * here: lowering it without a recursive policy could collapse two distinct
 * source states. Tagged unions retain their arm discriminator and can publish
 * direct absence arms safely.
 */
export interface DynamicFieldAbsencePolicy {
  readonly allowsNull: boolean
  readonly allowsUndefined: boolean
}

/**
 * Describe the null/undefined admissions of a representation tree, or return
 * null when the tree needs a richer recursive policy and must remain on the
 * existing descriptor route.
 */
export const dynamicFieldAbsencePolicy = (representation: Representation): DynamicFieldAbsencePolicy | null => {
  switch (representation.kind) {
    case 'optional': {
      if (representation.payload.kind === 'optional') return null
      const nested = dynamicFieldAbsencePolicy(representation.payload)
      if (nested === null || nested.allowsNull || nested.allowsUndefined) return null
      return { allowsNull: representation.absence === 'null', allowsUndefined: representation.absence === 'undefined' }
    }
    case 'tagged-union': {
      let allowsNull = false
      let allowsUndefined = false
      for (const arm of representation.arms) {
        if (arm.value.kind === 'optional' && arm.value.absence === 'null') return null
        const nested = dynamicFieldAbsencePolicy(arm.value)
        if (nested === null) return null
        allowsNull = allowsNull || nested.allowsNull
        allowsUndefined = allowsUndefined || nested.allowsUndefined
      }
      return { allowsNull, allowsUndefined }
    }
    case 'undefined':
      return { allowsNull: false, allowsUndefined: true }
    case 'null':
      return { allowsNull: true, allowsUndefined: false }
    case 'dynamic':
      return null
    default:
      return { allowsNull: false, allowsUndefined: false }
  }
}
