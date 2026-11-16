//! expect: record 1 2 3 calls 3
//! expect: class 11 12 calls 2
//! expect: plain 0.5 1
//! emitted-has: makeLiveViewWithOrigin<
//! emitted-has: gea::ArrayObject<gea_record_type_
// `Box` is a small record of numbers, the kind carried by value in an array of
// structs. Pushing an object whose `min` is a getter into a `Box[]` must not
// copy it: JavaScript calls the getter at every `boxes[i].min`, so a struct
// built at the push would answer every later read with the first call's value.
// A Box array no getter flows into stays a by-value array.

interface Box {
  min: number
  max: number
}

const boxes: Box[] = []
boxes.push({ min: 0.5, max: 1 })
let calls = 0
const counter = {
  get min(): number {
    calls++
    return calls
  },
  max: 6,
  label: 'counter'
}
if (boxes.length > 0) boxes.push(counter)
const first = boxes[1]!.min
const second = boxes[1]!.min
const third = boxes[1]!.min
console.log('record ' + first + ' ' + second + ' ' + third + ' calls ' + calls)

class Ticker {
  ticks = 10
  max = 8
  get min(): number {
    this.ticks++
    return this.ticks
  }
}
const ticker = new Ticker()
const fromClass: Box[] = [{ min: 1, max: 2 }]
if (fromClass.length > 0) fromClass.push(ticker)
const a = fromClass[1]!.min
const b = fromClass[1]!.min
console.log('class ' + a + ' ' + b + ' calls ' + (ticker.ticks - 10))

interface Pair {
  lo: number
  hi: number
}
const pairs: Pair[] = []
for (let n = 0; n < 2; n++) pairs.push({ lo: n + 0.5, hi: n + 1 })
console.log('plain ' + pairs[0]!.lo + ' ' + pairs[0]!.hi)
