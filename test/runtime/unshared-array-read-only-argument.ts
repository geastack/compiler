//! expect: merged 7 length 4 disposed 4 last true
// A `Blade[]` local handed to a `Geo[]` formal the callee only reads (length,
// index, for-of, a reading member with a one-parameter arrow): the callee
// cannot tell the caller's array from an element-wise copy, and the local is
// held by nothing else, so the argument is rebuilt once at the formal's
// element carrier. The caller's own writes after the call stay its own.
class Geo {
  constructor(public n: number) {}
}
class Blade extends Geo {
  m = 2
}
function merge(geometries: Geo[], _flag = false): number {
  if (!geometries.length) throw new Error('empty')
  let sum = geometries[0]!.n
  for (const geometry of geometries) sum += geometry.n
  return sum + geometries.map((geometry) => geometry.n).filter((n) => n > 100).length
}
function build(): string {
  const blades: Blade[] = []
  for (let i = 1; i <= 3; i++) blades.push(new Blade(i))
  const merged = merge(blades, false)
  blades.push(new Blade(4))
  let disposed = 0
  blades.forEach((blade) => (disposed += blade.m > 0 ? 1 : 0))
  return `merged ${merged} length ${blades.length} disposed ${disposed} last ${blades[3]!.n === 4}`
}
console.log(build())
export {}
