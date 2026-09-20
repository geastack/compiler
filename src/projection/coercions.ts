import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'

/**
 * ECMA-262 ToPrimitive, decided from a carrier alone.
 *
 * ApplyStringOrNumericBinaryOperator (13.15.3) and IsLessThan (7.2.13) both
 * run ToPrimitive on each operand BEFORE choosing between the string and the
 * numeric rule, and for every object this compiler carries that step has a
 * compile-time answer: an ordinary object with no own `valueOf` falls through
 * OrdinaryToPrimitive's `valueOf` attempt to `toString` whatever the hint,
 * so its primitive IS a string. A Date is the one exception -- its own
 * `@@toPrimitive` prefers `valueOf` for hint "number" -- and a primitive
 * carrier is already its own answer. The slot census reads this to decide
 * which coercion (`ToNumber` or `ToString`) a mixed-carrier operator's
 * operands take; the printer's ToNumber renderer reads the same set to know
 * which carriers reach a number only through their string.
 */
export const toStringOnlyObjectKinds: ReadonlySet<Representation['kind']> = new Set<Representation['kind']>([
  'record',
  'record-with-index',
  'native-record-ref',
  'class-ref',
  'array-object',
  'dictionary',
  'keyed-collection',
  'promise',
  'typed-array',
  'array-buffer',
  'shared-array-buffer',
  'data-view',
  'proxy-object'
])

/** Whether an operand's ToPrimitive is a String for every value the carrier can hold. */
export const provablyStringPrimitive = (representation: Representation, deriver: Pick<RepresentationDeriver, 'isDateCarrier'>): boolean =>
  representation.kind === 'string' ||
  (toStringOnlyObjectKinds.has(representation.kind) && !(deriver.isDateCarrier?.(representation) ?? false))
