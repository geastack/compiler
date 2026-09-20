import type { NativeEqualityRecipe } from '../../ir/native-equality.js'

const helpers: Readonly<Record<NativeEqualityRecipe['primitive'], string>> = {
  number: 'gea::strictEqualNumber',
  boolean: 'gea::strictEqualBoolean',
  string: 'gea::strictEqualString',
  symbol: 'gea::strictEqualSymbol',
  bigint: 'gea::strictEqualBigInt'
}

/** The verified IR selects the comparison; the target only spells its native entry. */
export const nativeEqualityText = (recipe: NativeEqualityRecipe, operands: readonly [string, string]): string => {
  const dynamic = operands[recipe.dynamicOperand]
  const native = operands[recipe.dynamicOperand === 0 ? 1 : 0]
  const comparison = `${helpers[recipe.primitive]}(${dynamic}, ${native})`
  return recipe.negate ? `!(${comparison})` : comparison
}
