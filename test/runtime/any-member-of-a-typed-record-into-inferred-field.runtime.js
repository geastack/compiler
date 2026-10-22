// @ts-nocheck
// A member a typed receiver declares as `any` holds whatever was stored in
// it: here a record literal's `data`, filled from a parsed document. The
// receiver's layout is known, but that member's value is not, and a field
// typed only by its constructor write converted it through a checked unbox.
// A record whose member is filled with a number leaves the field it fills
// (`total`) native.
const show = (value) => `${typeof value}:${value}`
class Holder {
  constructor() {
    this.count = 0
  }
  fill(record) {
    this.count = record.data
    return this
  }
}
class Tally {
  constructor() {
    this.total = 0
  }
  add(entry) {
    this.total = this.total + entry.amount
    return this
  }
  reset(entry) {
    this.total = entry.amount
    return this
  }
}
const record = { data: JSON.parse('"seven"') }
console.log(show(new Holder().fill(record).count))
const entry = { amount: 3 }
console.log(new Tally().reset(entry).add(entry).total)
//! expect: string:seven
//! expect: 6
//! emitted-lacks: gea::Value total;
export {}
