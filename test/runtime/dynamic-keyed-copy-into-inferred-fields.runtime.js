// @ts-nocheck
// An options copy by key, `this[ key ] = values[ key ]` over `for (key in
// values)`, writes each member of `values` into the field the key names. With
// `values` a parsed document nothing types, a number reaches the string field
// and a string the boolean one; both fields were typed only by their
// constructor writes, and the keyed store aborted on the first mismatch.
const show = (value) => `${typeof value}:${value}`
class Options {
  constructor(values) {
    this.label = 'none'
    this.enabled = true
    if (values !== undefined) this.setValues(values)
  }
  setValues(values) {
    for (const key in values) {
      const value = values[key]
      if (value === undefined) continue
      this[key] = value
    }
  }
}
const parsed = new Options(JSON.parse('{"label":5,"enabled":"yes"}'))
console.log(show(parsed.label), show(parsed.enabled))
console.log(show(new Options({ label: 'x' }).label), show(new Options().enabled))
//! expect: number:5 string:yes
//! expect: string:x boolean:true
export {}
