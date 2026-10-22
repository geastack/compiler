// @ts-nocheck
// `Object.assign(this, source)` with a `source` nothing types copies whatever
// keys the source holds onto the instance -- a write of an unknown value into
// every field of the class. The fields typed only by their constructor writes
// were laid out narrow, and the merge's dynamic write of a number into the
// string field aborted.
const show = (value) => `${typeof value}:${value}`
class Preferences {
  constructor() {
    this.label = 'none'
    this.count = 0
  }
  load(source) {
    Object.assign(this, source)
    return this
  }
}
const loaded = new Preferences().load(JSON.parse('{"label":7,"count":"x"}'))
console.log(show(loaded.label), show(loaded.count))
const kept = new Preferences().load(JSON.parse('{}'))
console.log(show(kept.label), show(kept.count))
//! expect: number:7 string:x
//! expect: string:none number:0
export {}
