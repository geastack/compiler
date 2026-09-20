//! expect: chain:15:bound bound add:0
//! expect: redefined:15:bound renamed:3
//! expect: nonfacts:15:"bound ":0
//! expect: infinite:Infinity
//! emitted-has: gea::bindCallable

type Counter = { base: number }

function add(this: Counter, left: number, right: number): number {
  return this.base + left + right
}

const bound = add.bind({ base: 10 }, 2)

// A second bind targets the first bound Function object. Its replacement
// thisArg is ignored, while its argument prefix is appended after the first
// prefix and its name receives one more "bound " prefix.
const chained = bound.bind({ base: 1000 }, 3)
console.log(`chain:${chained()}:${chained.name}:${chained.length}`)

// Object.defineProperty's target is deliberately dynamic: descriptor values
// are a genuine dynamic boundary, but `bound` itself remains a native callable
// and both views retain the same FunctionObjectIdentity.
const reflected: any = bound
Object.defineProperty(reflected, 'name', { value: 'renamed', configurable: true })
Object.defineProperty(reflected, 'length', { value: 4.75, configurable: true })
const redefined = bound.bind({ base: 2000 }, 3)
console.log(`redefined:${redefined()}:${redefined.name}:${redefined.length}`)

// Bind does not coerce these two properties. A non-string name contributes an
// empty suffix and a non-number length becomes zero.
Object.defineProperty(reflected, 'name', { value: 17, configurable: true })
Object.defineProperty(reflected, 'length', { value: '9', configurable: true })
const nonfacts = bound.bind({ base: 3000 }, 3)
console.log(`nonfacts:${nonfacts()}:${JSON.stringify(nonfacts.name)}:${nonfacts.length}`)

// ToIntegerOrInfinity preserves positive infinity.
Object.defineProperty(reflected, 'length', { value: Infinity, configurable: true })
const infinite = bound.bind({ base: 4000 }, 3)
console.log(`infinite:${infinite.length}`)
