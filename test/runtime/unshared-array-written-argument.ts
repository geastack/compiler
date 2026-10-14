//! expect-refusal: has no selected live native array reader
// The callee PUSHES into its `Geo[]` formal. In JS that push lands in the
// caller's `blades`; an element-wise copy would swallow it. The formal is not
// read only, so the argument keeps the array-to-array refusal.
class Geo {
  n = 1
}
class Blade extends Geo {
  m = 2
}
function grow(geometries: Geo[]): number {
  geometries.push(new Geo())
  return geometries.length
}
function build(): number {
  const blades: Blade[] = []
  blades.push(new Blade())
  grow(blades)
  return blades.length
}
console.log(build())
export {}
