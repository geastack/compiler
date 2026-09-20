/**
 * A cell holding `undefined | null | T`, guarded on ONE of its two absences.
 *
 * three's `@type {?Array<Plane>}` field is exactly this: a JS field is
 * readable before its constructor writes it, so the census tags both
 * absences, and `Material.copy`'s `if ( srcPlanes !== null )` rules out
 * exactly one. What is left is one absence beside one value -- which IS an
 * optional, and every read past the guard carries it.
 *
 * `conversion/build.ts` only ever drew an optional narrowing target from an
 * arm that was ITSELF an optional, so the cell answered the three-arm union
 * while its guarded reads answered `optional(T, undefined)` with no pair
 * between them in the graph: an unsatisfiable `binding-read-conversion` per
 * read, and nothing to say which side was wrong. The C++ registry already
 * installed `tagged-union -> optional(arm)`; only the pairing was missing.
 */
class Plane {
  constructor(readonly distance: number) {}
}

class Holder {
  planes: Plane[] | null | undefined = null
}

function total(source: Holder): number {
  const planes = source.planes
  if (planes !== null) {
    const kept = planes
    if (kept === undefined) return -1
    let sum = 0
    for (const plane of kept) sum += plane.distance
    return sum
  }
  return 0
}

const empty = new Holder()
const unset = new Holder()
unset.planes = undefined
const filled = new Holder()
filled.planes = [new Plane(2), new Plane(5)]

console.log(`${total(empty)},${total(unset)},${total(filled)}`)
