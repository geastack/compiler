// @ts-nocheck
// A field typed only by its constructor write, filled from a bare parameter
// no census typed or from a call the checker types `any`. The parameter
// holds what its callers pass -- here a parsed document's member at one call
// site -- and `JSON.parse` or a function returning its result hands back
// whatever was parsed. The fields were laid out narrow and the stores
// aborted in their checked unbox where Node stores the value.
const show = (value) => `${typeof value}:${value}`
class Slot {
  constructor() {
    this.value = 0
    this.label = 'none'
    this.payload = 'none'
  }
  set(value) {
    this.value = value
    return this
  }
  rename(label) {
    this.label = label
    return this
  }
  load(text) {
    this.payload = JSON.parse(text)
    return this
  }
}
const parse = (text) => JSON.parse(text)
const slot = new Slot()
console.log(show(slot.set(1).value), show(slot.set(parse('{"v":"two"}').v).value))
console.log(show(slot.rename('x').label), show(slot.rename(parse('3')).label))
console.log(show(slot.load('7').payload), show(slot.load('null').payload))
//! expect: number:1 string:two
//! expect: string:x number:3
//! expect: number:7 object:null
export {}
