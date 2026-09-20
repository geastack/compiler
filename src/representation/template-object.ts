import { representationKey, type Representation } from './model.js'

/**
 * The one physical carrier which can implement ECMAScript's
 * `GetTemplateObject` result.  Keeping this object here makes the capability
 * claimed by preflight and the shape consumed by an emitter one fact: a plain
 * `readonly string[]` is assignable *from* this value, but is not itself a
 * sufficient carrier for producing it.
 */
const templateString: Representation = { kind: 'string' }

const templateRaw: Extract<Representation, { kind: 'array-object' }> = {
  kind: 'array-object',
  element: templateString,
  ownership: 'shared-refcount',
  extension: null
}

export const completeTemplateObjectCarrier: Extract<Representation, { kind: 'array-object' }> = {
  kind: 'array-object',
  element: templateString,
  ownership: 'shared-refcount',
  extension: [{ key: 'raw', value: templateRaw, required: true }]
}

export const completeTemplateObjectCarrierKey = representationKey(completeTemplateObjectCarrier)

export const templateObjectCapabilityKeyOf = (representation: Representation): string =>
  `allocation:template-object:${representationKey(representation)}`

export const completeTemplateObjectCapabilityKey = templateObjectCapabilityKeyOf(completeTemplateObjectCarrier)

/** Canonical-key equality deliberately includes cooked, raw, ownership, and every extension field. */
export const isCompleteTemplateObjectCarrier = (
  representation: Representation
): representation is Extract<Representation, { kind: 'array-object' }> =>
  representationKey(representation) === completeTemplateObjectCarrierKey
