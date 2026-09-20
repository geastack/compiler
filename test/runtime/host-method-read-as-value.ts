//! expect: 2.5
//! expect: 7.5
//! expect: 3.5

// A host method is an ordinary function object in the language: picking one as
// the right operand of `??` reads a VALUE, and the host states a spelling only
// for the call. The read renders as a captureless thunk over the slot's own
// convention, exactly as a free host function's read already does.
interface Parsing {
  readonly toNumber: (text: string) => number
}

const numberOf = (text: string, parsing?: Parsing): number => (parsing?.toNumber ?? Number.parseFloat)(text)
console.log(numberOf('2.5'))
console.log(numberOf('2.5', { toNumber: (text: string) => Number.parseFloat(text) * 3 }))

// Read into an ordinary binding and called through it, not only used inline.
const parse: (text: string) => number = Number.parseFloat
console.log(parse('3.5'))
