/**
 * The intrinsic builtin functions a program can hold as function values only
 * through a chain no carrier models (`normalize/intrinsic-accessor-getter.ts`
 * recognizes those chains): an accessor's getter reached reflectively, and
 * `Function.prototype.toString`, whose owner `Function.prototype` this
 * backend deliberately has no object for. Carried on a `unary` computation's
 * `operator`, so the IR and the target read the same identity without any
 * source text.
 */
export type IntrinsicAccessorGetter = 'TypedArray.prototype[@@toStringTag]' | 'Function.prototype.toString'

const operatorPrefix = 'IntrinsicAccessorGetter:'

export const intrinsicAccessorGetterOperator = (getter: IntrinsicAccessorGetter): string => `${operatorPrefix}${getter}`

export const intrinsicAccessorGetters: readonly IntrinsicAccessorGetter[] = [
  'TypedArray.prototype[@@toStringTag]',
  'Function.prototype.toString'
]

export const intrinsicAccessorGetterOfOperator = (operator: string): IntrinsicAccessorGetter | null =>
  intrinsicAccessorGetters.find((getter) => operator === intrinsicAccessorGetterOperator(getter)) ?? null
