//! expect: n=7 u=q
// A generic METHOD whose copy exists only under the SECOND copy of its
// generic class.
//
// `Chain<number>` and `Chain<3>` are assignment-compatible and their
// layout-relevant filling derives to the same carrier, so the two census
// copies keep one shared struct and merge into one published class. Each
// copy minted its own `tag` body -- `R = number` under the first, `R =
// string` under the second -- and merging the members by KEY alone kept only
// the first copy's list, so the body the second call site needs was gone
// before any call could resolve to it. Measured: `u.tag('q')` was rendered
// into the number-returning body and refused, "passes a string argument into
// a parameter slot carrying scalar(number)". Methods now merge by key AND
// body (`projection/classes.ts`'s `mergedMethods`), and the call picks among
// them by the convention its own read published.
class Chain<T> {
  value: T
  constructor(value: T) {
    this.value = value
  }
  tag<R>(received: R): R {
    return received
  }
}

const n = new Chain<number>(1)
const u = new Chain<3>(3)
console.log('n=' + n.tag(7) + ' u=' + u.tag('q'))
