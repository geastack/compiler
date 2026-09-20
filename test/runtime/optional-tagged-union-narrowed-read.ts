// tsc: `let mapper: TypeMapper | undefined` (checker.ts `resolveObjectTypeMembers`),
// assigned on one path and then read where flow has proven it present:
// `instantiateSignatures(source.declaredCallSignatures, mapper)`. The cell is
// `optional(tagged-union)`; the read wants the bare tagged union.
// Spelled as tsc does (types.ts): a literal discriminant (tsc's is the const
// enum `TypeMapKind`, which the checker reads as these literals), anonymous
// object-literal arms, one arm carrying TWO discriminant values, and the fifth
// arm recursive through the alias itself.
interface Type {
  readonly id: number
}
type TypeMapper =
  | { kind: 0; source: Type; target: Type }
  | { kind: 1; sources: readonly Type[]; targets: readonly Type[] | undefined }
  | { kind: 2; sources: readonly Type[]; targets: (() => Type)[] }
  | { kind: 3; func: (t: Type) => Type; debugInfo?: () => string }
  | { kind: 4 | 5; mapper1: TypeMapper; mapper2: TypeMapper }

const indexOfType = (types: readonly Type[], t: Type): number => {
  for (let i = 0; i < types.length; i++) if (types[i]!.id === t.id) return i
  return -1
}
const applyMapper = (mapper: TypeMapper, t: Type): Type => {
  switch (mapper.kind) {
    case 0:
      return t.id === mapper.source.id ? mapper.target : t
    case 1: {
      const i = indexOfType(mapper.sources, t)
      return mapper.targets !== undefined && i >= 0 ? mapper.targets[i]! : t
    }
    case 2: {
      const i = indexOfType(mapper.sources, t)
      return i >= 0 ? mapper.targets[i]!() : t
    }
    case 4:
    case 5:
      return applyMapper(mapper.mapper2, applyMapper(mapper.mapper1, t))
    case 3:
      return mapper.func(t)
  }
}
const T = (id: number): Type => ({ id })
const doubler: TypeMapper = { kind: 3, func: (t) => T(t.id * 2) }

// `createTypeMapper` returns the declared `TypeMapper`, but only ever two of
// its arms; the return census narrows what the CELL holds to those, while the
// read after `mapper === undefined` is typed as the whole union by the checker.
const createMapper = (sources: readonly Type[], targets: readonly Type[]): TypeMapper =>
  sources.length === 1 ? { kind: 0, source: sources[0]!, target: targets[0]! } : { kind: 1, sources, targets }

const resolve = (typeParameters: readonly Type[], typeArguments: readonly Type[] | undefined, value: Type): number => {
  let mapper: TypeMapper | undefined
  let base = value
  if (typeArguments !== undefined && typeParameters.length === typeArguments.length) {
    mapper = createMapper(typeParameters, typeArguments)
    base = applyMapper(mapper, value)
  }
  if (mapper === undefined) return base.id
  return applyMapper(mapper, T(base.id + 100)).id
}
console.log(
  resolve([T(1)], [T(10)], T(1)),
  resolve([T(1), T(2)], [T(10), T(20)], T(2)),
  resolve([T(1)], undefined, T(4)),
  resolve([T(1)], [T(1), T(2)], T(5)),
  applyMapper(doubler, T(3)).id,
  applyMapper({ kind: 5, mapper1: doubler, mapper2: { kind: 0, source: T(6), target: T(7) } }, T(3)).id
)
//! expect: 110 120 4 5 6 7
