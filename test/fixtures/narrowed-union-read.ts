// The union half of the same disagreement: a cell holding a tagged union, read
// as one arm. The load is `gea::TaggedUnion::get<Index>`, selected by the arm's
// position in the checker's own order, and it is installed alongside the
// optional unwrap in `targets/cpp/conversions.ts`.
//
// It is kept separate from `narrowed-read.ts` so the optional unwrap stays
// provable on its own, and because this one proves two more things the other
// cannot. The guard renders as `v0.is<0>() ? "string" : "number"` -- `typeof`
// reading the discriminant the carrier already keeps, rather than a runtime tag
// nobody stores. And the initializer renders as
// `TaggedUnion<std::string, double>::ofArm<1>(v0)`: storing one arm into a union
// cell is a widening, and it is written out for the same reason the read is,
// because C++ will not guess which arm a bare `double` was meant to be.
export const measure: string | number = 3

export function measureText(): string {
  if (typeof measure === 'string') return measure
  return 'number'
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const measured = measureText()
