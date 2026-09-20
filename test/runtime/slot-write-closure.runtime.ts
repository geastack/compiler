// A method slot's TARGET set is a question about writes, not about every
// caller: `stir` calls `.copy` through an `any` it cannot resolve, which used
// to open `V.copy` for every typed caller in the program (three's math
// classes, 1,179 refused sites in the three.js app), and the host-mutation census then
// read each of those calls as an unauthenticated callee. Nothing writes the
// slot, so the typed call dispatches to the one declared body.
class V {
  x = 0
  copy(o: V): this {
    this.x = o.x
    return this
  }
}
// The mention that used to open the slot; never executed, since a method
// call on a boxed class instance is a different (dynamic-dispatch) question.
function stir(x: any): number {
  if (!x) return x.copy(x).x
  return 1
}
const a = new V()
const b = new V()
b.x = 7
a.copy(b)
console.log(a.x)
console.log(stir(b))
//! expect: 7
//! expect: 7
