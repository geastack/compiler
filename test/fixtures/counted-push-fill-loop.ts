// A counted `push` loop is one bulk append (`emit-arrays.ts`'s `collectFillLoop`),
// and the rewrite renders the loop bound on both sides of the append. Kept as a
// fixture because that rewrite now rests on a check rather than on the fact
// that a bound reading the array it appends to cannot terminate.

export const filled = (count: number): number => {
  const values: number[] = []
  for (let i = 0; i < count; i++) values.push(7)
  return values.length
}

export const total: number = filled(4)
