import type { Representation } from '../representation/model.js'

/** A strict comparison reads the dynamic discriminant; its typed operand needs no carrier conversion. */
export interface NativeEqualityRecipe {
  readonly dynamicOperand: 0 | 1
  readonly primitive: 'number' | 'boolean' | 'string' | 'symbol' | 'bigint'
  readonly negate: boolean
}

export const nativeEqualityOf = (
  operator: string,
  operands: readonly { readonly representation: Representation }[]
): NativeEqualityRecipe | null => {
  if ((operator !== '===' && operator !== '!==') || operands.length !== 2) return null
  const left = operands[0]!.representation
  const right = operands[1]!.representation
  const dynamicOperand = left.kind === 'dynamic' ? 0 : right.kind === 'dynamic' ? 1 : null
  if (dynamicOperand === null) return null
  const typed = dynamicOperand === 0 ? right : left
  const primitive =
    typed.kind === 'string' || typed.kind === 'symbol'
      ? typed.kind
      : typed.kind === 'scalar'
        ? typed.domain === 'boolean' || typed.domain === 'bigint'
          ? typed.domain
          : 'number'
        : null
  return primitive === null ? null : { dynamicOperand, primitive, negate: operator === '!==' }
}
