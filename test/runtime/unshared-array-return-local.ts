//! expect: 4 1 2 true
// `return out` where `out` is a `const` array literal the body only fills and
// reads: the local is the array's one holder and dies at the return, so the
// `Blade[]` it holds may be rebuilt once as the declared `Geo[]` -- each element
// crossing by identity -- with nothing left to observe the copy.
class Geo {
  n = 1
}
class Blade extends Geo {
  m = 2
}
const shared = new Blade()
function collect(count: number): Geo[] {
  const out: Blade[] = []
  for (let i = 0; i < count - 1; i++) out.push(new Blade())
  out.push(shared)
  if (out.length !== count) throw new Error('lost a push')
  return out
}
const all = collect(3)
all.push(new Geo())
console.log(all.length, all[0]!.n, (all[2] as Blade).m, all[2] === shared)
export {}
