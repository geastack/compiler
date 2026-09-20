// A `{}` literal with zero properties, never typed by an annotation, a cast,
// or the checker's own JS expando inference (`object-bag-bindings.ts`'s
// `isBareEmptyLiteral` / `declaresOwnType`), is an OPEN PROPERTY BAG this
// census infers member types for from the writes the program actually makes.
// `bag.lightProbeGrid` is written a `boolean` in one function and a
// `Grid | null` in another -- three's own
// `materialProperties.lightProbeGrid` shape -- so no single write covers the
// other. Before the fix, `joined` answered only `widestOf`, which refuses a
// genuine disagreement, and the member degraded to `any`: every read of
// `lightProbeGrid`, and the `instanceof` narrowing below, went through the
// dynamic box. After the fix, `joined` falls back to `disjointUnionTypeOf`,
// which builds the REAL union `boolean | Grid | null` through the checker,
// and the read narrows natively.
class Grid {
  constructor() {
    this.texture = 5
  }
}

const bag = {}

/** @param {Grid[]} grids */
function markAcquired(grids) {
  // @ts-ignore -- `lightProbeGrid` is a bag member this census infers, not a stated `{}` field.
  bag.lightProbeGrid = grids.length > 0
}

/** @param {Grid | null} found */
function attachGrid(found) {
  // @ts-ignore -- see above.
  bag.lightProbeGrid = found
}

function report() {
  // @ts-ignore -- see above.
  const v = bag.lightProbeGrid
  if (v instanceof Grid) console.log(v.texture)
  else console.log(typeof v, v)
}

markAcquired([])
report()

attachGrid(new Grid())
report()

attachGrid(null)
report()

export { report }
