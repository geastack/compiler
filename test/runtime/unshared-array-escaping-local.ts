//! expect-refusal: has no selected live native array reader
// Each local below has a second holder, so no conversion may copy it:
// `kept` is also stored on an object before it is returned (the caller's copy
// would not be the array `holder.list` names), and `seen` is captured by a
// closure the read-only callee runs while the copy is outstanding.
class Geo {
  n = 1
}
class Blade extends Geo {
  m = 2
}
const holder: { list: Blade[] } = { list: [] }
function keep(): Geo[] {
  const kept: Blade[] = []
  kept.push(new Blade())
  holder.list = kept
  return kept
}
function measure(geometries: Geo[], before: () => void): number {
  before()
  return geometries.length
}
function build(): number {
  const seen: Blade[] = []
  seen.push(new Blade())
  return measure(seen, () => seen.push(new Blade()))
}
const result = keep()
result.push(new Geo())
console.log(holder.list.length, build())
export {}
