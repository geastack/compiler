import type { NumberScalar } from '../../conversion/number-storage.js'
import type { Representation } from '../../representation/model.js'

// `spell` takes a whole `Representation`, and the integer carrier is rebuilt
// as one rather than handed over as the `NumberScalar` intersection: callers
// pass spellers typed over `Representation`, and neither a function over the
// union standing in for one over the intersection nor the intersection
// widening to the union has a native conversion. The spellers read the
// carrier by content (`cppTypeOf`/`representationKey`), so the copy spells
// identically.
export const numberStorageText = (target: NumberScalar, text: string, spell: (target: Representation) => string): string =>
  target.integerWidth === undefined
    ? `static_cast<double>(${text})`
    : `gea::toDeclaredInteger<${spell({ kind: 'scalar', domain: target.domain, integerWidth: target.integerWidth })}>(${text})`
