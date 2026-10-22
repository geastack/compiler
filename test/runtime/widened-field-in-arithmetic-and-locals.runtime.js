// @ts-nocheck
// A field widened to `any` (a copy stores a parsed document's member into
// it) feeds arithmetic, comparisons and locals the checker still types from
// the constructor's number: `v + v` is the string "77" when the document held
// "7", so the local holding it is dynamic, while `v * 2` is always a Number.
class Box {
  constructor() {
    this.v = 0
  }
  load(source) {
    this.v = source.v
    return this
  }
}
const box = new Box().load(JSON.parse('{"v":"7"}'))
const sum = box.v + box.v
const twice = box.v * 2
console.log(sum, twice, box.v < 10, box.v + 1 > 70, -box.v)
//! expect: 77 14 true true -7
export {}
