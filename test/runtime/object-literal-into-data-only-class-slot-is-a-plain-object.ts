// A database client writes plain object literals where a data-only CLASS is
// the declared type: `override writeConcern: WriteConcern = { w: 0 }`
// (its end-sessions operation) and `WriteConcern.apply(command, { wtimeoutMS:
// 10000, w: 'majority', ...wc })` (its session module). `structural-layout-type.ts`
// lays such a literal out as its contextual type, so it reaches allocation as
// a `class-ref`.
//
// The literal is an ordinary object, not an instance: JavaScript answers
// `false` for `instanceof WriteConcern` on it (and `Object` for its
// `constructor`), and the driver's own `WriteConcern.fromOptions` branches on
// exactly that test. A data-only class lends the literal its native layout,
// but the block carries a plain-object identity, so every instance test and
// boxed reflection still answers `false`/`Object` for it while a real
// instance answers `true`. Under this suite's `useDefineForClassFields: false`
// the answers are
// `0/undefined/undefined/false`, `1/10000/undefined/false`,
// `1/5/undefined/false` and `1/undefined/undefined/true`.
class WriteConcern {
  readonly w?: number | string
  readonly wtimeoutMS?: number
  journal?: boolean
  constructor(w?: number | string, wtimeoutMS?: number) {
    if (w != null) this.w = w
    if (wtimeoutMS != null) this.wtimeoutMS = wtimeoutMS
  }
  static describe(concern: WriteConcern): string {
    return `${concern.w}/${concern.wtimeoutMS}/${concern.journal}/${concern instanceof WriteConcern}`
  }
}

class Operation {
  writeConcern: WriteConcern = { w: 0 }
}

console.log(WriteConcern.describe(new Operation().writeConcern))
const wc = new WriteConcern(1)
console.log(WriteConcern.describe({ wtimeoutMS: 10000, w: 'majority', ...wc }))
console.log(WriteConcern.describe({ ...wc, wtimeoutMS: 5 }))
console.log(WriteConcern.describe(wc))

//! expect: 0/undefined/undefined/false
//! expect: 1/10000/undefined/false
//! expect: 1/5/undefined/false
//! expect: 1/undefined/undefined/true
