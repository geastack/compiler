import type { NumberScalar } from '../../conversion/number-storage.js'

export const numberStorageText = (target: NumberScalar, text: string, spell: (target: NumberScalar) => string): string =>
  target.integerWidth === undefined ? `static_cast<double>(${text})` : `gea::toDeclaredInteger<${spell(target)}>(${text})`
