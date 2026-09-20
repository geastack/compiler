// Root: `conversion:dynamic->tagged-union(discriminated)`
//
// VERIFIED mechanism (an earlier draft of this comment blamed `OpC`'s
// `Record<string, unknown>` field -- wrong; removing that field, or dropping
// `OpC` entirely, reproduces identically): a NAMED interface derives as
// `native-record-ref` (`src/representation/derive.ts`'s `'declared'` case),
// and `src/conversion/derive.ts`'s `deriveAt` refuses that representation
// kind UNCONDITIONALLY -- "an erased/borrowed native reference is not
// recoverable from a dynamic value" -- with no registry consulted at all.
// Independently, even an ANONYMOUS object-literal arm (which derives as bare
// `record`, not `native-record-ref`) fails the identical way: `deriveRecord`
// needs `registry.recordMaterializer(shapeId, ownership)`, and grepping
// `src/targets/cpp/conversions.ts` for `recordMaterializer` finds zero
// installations -- the C++ backend's registry never overrides that key away
// from `emptyConversionRegistry`'s permanent `() => null`, so `deriveRecord`
// is `never` for every record shape, unconditionally, independent of what its
// fields are.
//
// `deriveTaggedUnion`'s `isMaterializable` rule then requires EVERY arm
// materializable (`algebra.ts`, `kind: 'sum'`: `arms.every(isMaterializable)`)
// before the whole union can be reached from `dynamic` -- so ANY discriminated
// union with so much as one plain-object or named-interface arm is
// permanently `not-materializable`, which is most of them: mongodb's
// many-armed bulk-write/command-option unions are built almost entirely out
// of exactly these two arm shapes.

interface OpA {
  kind: 'a'
  value: number
}

interface OpB {
  kind: 'b'
  value: string
}

interface OpC {
  kind: 'c'
  extra: Record<string, unknown>
}

type Op = OpA | OpB | OpC

// An array's element carrier is one shared physical type across every
// element, decided from the two concrete literals below -- so pushing `x`
// (declared `any`, never narrowed: genuinely `dynamic`) into it is the one
// construct that cannot be answered by leaving `x` boxed and calling it done;
// the plan must ask whether a `dynamic` value can materialize into the
// array's already-concrete `Op` element carrier.
export function apply(x: any): number {
  const ops: Op[] = [
    { kind: 'a', value: 1 },
    { kind: 'b', value: 'y' }
  ]
  ops.push(x)
  return ops.length
}
