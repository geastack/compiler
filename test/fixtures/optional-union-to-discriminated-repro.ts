// Root: `binding-read-conversion:optional(tagged-union)->tagged-union(discriminated)`
//
// The parameter's CELL carrier is `optional(tagged-union(string|number|RecA|RecB))`.
// Two successive guards each rule out more than one arm in a single step --
// `input == null` strips the optional, `typeof input !== 'object'` strips BOTH
// `string` and `number` at once -- leaving a narrowed READ whose carrier is a
// bare 2-arm `tagged-union(RecA|RecB)`. That exact (cell, read) pair is never a
// node in the conversion graph: `conversion/build.ts`'s `narrowingTargetsOf`
// only ever enumerates the full union, each single arm alone, each arm
// optional-wrapped, and unions with exactly ONE arm dropped
// (`dropOneArmUnionsOf`) -- never a subset reached by dropping more than one
// arm in one step, which is exactly what a `typeof x !== 'object'` guard (or
// any user-defined multi-arm type predicate) produces against a >=4-arm union.
// mongodb's `sort.ts` `formatSort` hits this identical shape against `Sort`.

interface RecA {
  kind: 'a'
  a: number
}

interface RecB {
  kind: 'b'
  b: string
}

type Shape = string | number | RecA | RecB

function readRecord(x: RecA | RecB): string {
  return x.kind
}

export function useShape(input: Shape | undefined): string | undefined {
  if (input == null) return undefined
  if (typeof input !== 'object') return undefined
  return readRecord(input)
}
