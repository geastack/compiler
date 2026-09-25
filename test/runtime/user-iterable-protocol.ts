//! expect: for-of-generator 1,2,3
//! expect: for-of-record 3,2,1 closed=0
//! expect: break-record 3 closed=1
//! expect: break-generator 1 finally=1
//! expect: call-generator 10
//! expect: push-generator 0,1,2,3
//! expect: call-record 6
//! expect: push-record 9,3,2,1
//! expect: array-record 3,2,1 length=3
//! expect: array-generator 2,3,4
//! expect: pattern-generator 1 2 finally=1
//! expect: rest-generator 1 [2,3]
//! expect: dynamic 1,2|3|4,5

// The general iterator protocol over values whose `@@iterator` the program
// wrote itself: a generator method, and an ordinary method returning an
// iterator object with its own `next()` and `return()`.
//
// Every form reads the one GetIterator record the protocol step publishes and
// never the source again: `for`-`of` steps it and closes it on `break`
// (ECMA-262 7.4.8 IteratorClose calls `return()`), and a spread drains it
// with no close (13.2.4.2 ArrayAccumulation, 13.3.8.1 ArgumentListEvaluation).
// A generator method's record is the native cursor, which a spread
// range-copies; an iterator object's record is gathered through its own
// `next()`. Before, a spread into a call over either one was refused as "a
// spread argument whose source is not an array, a Set, a Map, a string, a
// generator or a genuinely dynamic value needs the general iterator
// protocol", and an array spread over an iterator object had no lowering.
//! emitted-has: gea::appendIteratorRange
//! emitted-has: for (;;) {

type Step = { value: number; done: boolean }

class Span {
  finallyRuns = 0
  readonly from: number
  readonly to: number
  constructor(from: number, to: number) {
    this.from = from
    this.to = to
  }
  *[Symbol.iterator](): Generator<number> {
    try {
      for (let i = this.from; i < this.to; i++) yield i
    } finally {
      this.finallyRuns += 1
    }
  }
}

class Countdown {
  closed = 0
  readonly start: number
  constructor(start: number) {
    this.start = start
  }
  [Symbol.iterator](): { next(): Step; return(): Step } {
    let n = this.start
    const owner = this
    return {
      next(): Step {
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

const sum = (...values: number[]): number => values.reduce((total, value) => total + value, 0)

const fromGenerator: number[] = []
for (const value of new Span(1, 4)) fromGenerator.push(value)
console.log('for-of-generator ' + fromGenerator.join(','))

const countdown = new Countdown(3)
const fromRecord: number[] = []
for (const value of countdown) fromRecord.push(value)
console.log('for-of-record ' + fromRecord.join(',') + ' closed=' + countdown.closed)

const early = new Countdown(3)
let firstSeen = 0
for (const value of early) {
  firstSeen = value
  break
}
console.log('break-record ' + firstSeen + ' closed=' + early.closed)

const span = new Span(1, 9)
let spanFirst = 0
for (const value of span) {
  spanFirst = value
  break
}
console.log('break-generator ' + spanFirst + ' finally=' + span.finallyRuns)

console.log('call-generator ' + sum(...new Span(1, 5)))
const pushedGenerator: number[] = [0]
pushedGenerator.push(...new Span(1, 4))
console.log('push-generator ' + pushedGenerator.join(','))

console.log('call-record ' + sum(...new Countdown(3)))
const pushedRecord: number[] = [9]
pushedRecord.push(...new Countdown(3))
console.log('push-record ' + pushedRecord.join(','))

const gathered = [...new Countdown(3)]
console.log('array-record ' + gathered.join(',') + ' length=' + gathered.length)
console.log('array-generator ' + [...new Span(2, 5)].join(','))

const patterned = new Span(1, 9)
const [a, b] = patterned
console.log('pattern-generator ' + a + ' ' + b + ' finally=' + patterned.finallyRuns)
const [head, ...tail] = new Span(1, 4)
console.log('rest-generator ' + head + ' [' + tail.join(',') + ']')

// A source the program leaves statically unknown takes the dynamic protocol
// in every one of the same forms.
const unknownSource: any = JSON.parse('[1, 2, 3, 4, 5]')
const [first, second] = unknownSource
const dynamicSeen: number[] = []
for (const value of unknownSource) if (value === 3) dynamicSeen.push(value)
console.log('dynamic ' + [first, second].join(',') + '|' + dynamicSeen.join(',') + '|' + [...unknownSource].slice(3).join(','))
export {}
