// Object spread's `CopyDataProperties` (ECMA-262 7.3.25) when the SOURCE's
// own-property set is not statically known -- a plain index-signature type,
// or (the harder case, mirroring hono's `HeaderRecord`) a union with one
// arm that is a fixed record and one that is an index signature. Before
// `producers/protocol.ts` learned to publish a runtime copy for this and
// `structural-layout-type.ts` learned to pick the union's own index-
// signature arm as the receiving literal's layout, the whole enclosing
// object literal was refused at the census -- `spreadCopyOf`
// (producers/allocations.ts) aborted outright when the spread source's own
// type had no statically enumerable member list
// (`staticSpreadMembersOf`, producers/shared.ts).

// Case 1: the source is a PLAIN dictionary. `emit-allocation.ts`'s
// `emitSpreadCopy` renders this as a runtime key walk
// (`gea::Dictionary::copyInto`, gea_runtime.h).
export function withDefault(headers: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'text/plain',
    ...headers
  }
}

// Case 2: the source's OWN type is a union of a fixed record and an index
// signature -- the shape `HeaderRecord` in hono's `context.ts` actually
// has. TypeScript drops the index signature from its OWN inferred type of
// the spread's result (`{ a: string }`, no index info survives), so the
// receiving literal's layout has to come from the DECLARED return type
// here, not the checker's inferred type of the literal itself -- exactly
// the soundness trap `structural-layout-type.ts`'s `spreadsDynamicSource`
// branch exists to avoid.
type FixedOrDynamic = Record<'kind', string> | Record<string, string>

// `label`, not `kind`: a literal key that COULD be present in the fixed
// record arm's own type would trip TypeScript's own "specified more than
// once" suggestion diagnostic (ts(2783)) and refuse certification for a
// reason that has nothing to do with this backend -- the real hono source
// this fixture mirrors reaches that same diagnostic too, on top of ~19
// unrelated gaps, so it never reaches "cert: yes" either. Keeping the
// literal's own key OUTSIDE the fixed arm's key set here isolates this
// fixture to the one question it exists to answer: does the runtime copy
// itself compile and run.
export function withUnionSource(extra: FixedOrDynamic): FixedOrDynamic {
  return {
    label: 'default',
    ...extra
  }
}

// Called at module scope so both bodies are emitted rather than shaken away.
export const probeDictionary = withDefault({ a: '1' })
export const probeUnion = withUnionSource({ kind: 'y' })
