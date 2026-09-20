//! expect: doubled=2 text=x!
//! expect: kept=[1,2] label=two
// A generic METHOD on a PLAIN class, called at two different type arguments.
// Monomorphization gives `map<R>` one body per `R`, and both install
// themselves on the class under the one name they share -- so the class
// layout holds two `ClassMethod`s keyed `"map"` and a lookup by key alone
// cannot say which body a call means. It used to take the first, which put
// the second call site's callback into the first body's parameter slot:
// `(value) => 'x!'` is a `(number) -> string` written into a
// `(number) -> number` formal, and the emitter refused with no conversion
// installed. The read itself carries the copy's convention, so the call
// resolves its body by that (`ir/call-dispatch.ts`'s method-copy preference)
// rather than by name.
class Box {
  value: number
  constructor(value: number) {
    this.value = value
  }
  map<R>(transform: (value: number) => R): R {
    return transform(this.value)
  }
}

const n = new Box(1)
console.log('doubled=' + n.map((value) => value * 2) + ' text=' + n.map((value) => 'x!'))

// The same method at a COMPOSITE argument, so the copies differ by more than
// a scalar: one returns an array, the other a string.
console.log('kept=' + JSON.stringify(n.map((value) => [value, value + 1])) + ' label=' + n.map(() => 'two'))
