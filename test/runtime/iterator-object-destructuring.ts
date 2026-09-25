//! expect: pair 5 4 steps=2 closed=1
//! expect: short 2 1 undefined steps=3 closed=0
//! expect: elided 4 steps=2 closed=1
//! expect: rest 5 [4,3,2,1] steps=6 closed=0
//! expect: exact 1 steps=2 closed=0
//! expect: looped 3,2|3,2 closed=2

// Array destructuring over an iterator OBJECT the program wrote: a class whose
// `[Symbol.iterator]()` returns a record with its own `next()` and `return()`,
// not a generator.
//
// ECMA-262 8.6.3 IteratorBindingInitialization steps the one iterator record
// once per position, stops calling `next()` once it reports `done` (every
// later position is `undefined`), lets a rest element drain what is left, and
// closes the iterator -- calls `return()` -- only when the pattern ends while
// it is still open. So the record needs an exhaustion state that outlives each
// step; the positions, the rest and the close all read the same one. Before,
// the pattern read position 0 of the iterator record as if it were a tuple:
// "an array-pattern element reads position 0 of a record tuple, whose record
// layout has no field keyed 0".

type Step = { value: number; done: boolean }

class Countdown {
  closed = 0
  steps = 0
  readonly start: number
  constructor(start: number) {
    this.start = start
  }
  [Symbol.iterator](): { next(): Step; return(): Step } {
    let n = this.start
    const owner = this
    return {
      next(): Step {
        owner.steps += 1
        if (n <= 0) return { value: 0, done: true }
        n -= 1
        return { value: n + 1, done: false }
      },
      return(): Step {
        owner.closed += 1
        return { value: 0, done: true }
      }
    }
  }
}

const five = new Countdown(5)
const [a, b] = five
console.log('pair ' + a + ' ' + b + ' steps=' + five.steps + ' closed=' + five.closed)

const two = new Countdown(2)
const [x, y, z] = two
console.log('short ' + x + ' ' + y + ' ' + z + ' steps=' + two.steps + ' closed=' + two.closed)

const skipped = new Countdown(5)
const [, second] = skipped
console.log('elided ' + second + ' steps=' + skipped.steps + ' closed=' + skipped.closed)

const drained = new Countdown(5)
const [head, ...tail] = drained
console.log('rest ' + head + ' [' + tail.join(',') + '] steps=' + drained.steps + ' closed=' + drained.closed)

// The pattern takes exactly as many positions as the source yields: the
// second `next()` reports done, so there is nothing left to close.
const one = new Countdown(1)
const [only, missing] = one
console.log('exact ' + only + (missing === undefined ? '' : ' ' + missing) + ' steps=' + one.steps + ' closed=' + one.closed)

// The same pattern in a loop starts from a fresh iterator, and a fresh
// exhaustion state, every time.
const looped = new Countdown(3)
const seen: string[] = []
for (let round = 0; round < 2; round++) {
  const [first, next] = looped
  seen.push(first + ',' + next)
}
console.log('looped ' + seen.join('|') + ' closed=' + looped.closed)
export {}
