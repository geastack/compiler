// @ts-nocheck
// The number-field form of an inferred field receiving a dynamic store: the
// constructor's `this.count = 0` types it, a `copy(source)` off a parsed
// document fills it with whatever the document held.
class Counter {
  constructor() {
    this.count = 0
  }
  copy(source) {
    this.count = source.count
    return this
  }
  bump() {
    this.count += 1
    return this
  }
}

const show = (value) => `${typeof value}:${value}`
const inputs = ['{"count":3}', '{}', '{"count":null}', '{"count":"7"}']
for (const text of inputs) console.log(show(new Counter().copy(JSON.parse(text)).bump().count))
//! expect: number:4
//! expect: number:NaN
//! expect: number:1
//! expect: string:71
export {}
