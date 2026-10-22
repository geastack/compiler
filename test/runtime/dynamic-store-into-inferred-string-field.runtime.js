// @ts-nocheck
// A JavaScript class field typed only by its constructor write (`this.label =
// 'none'`) is a string to the checker, but a `copy(source)` that stores
// `source.label` off a value nothing types can deliver anything a JS object
// holds there: an absent key, `null`, a number. Node stores each as it is; a
// field laid out as a native string aborted in the checked unbox of the first
// non-string.
class Label {
  constructor() {
    this.label = 'none'
  }
  copy(source) {
    this.label = source.label
    return this
  }
}

const show = (value) => `${typeof value}:${value}`
console.log(show('literal'))
const inputs = ['{"label":"x"}', '{}', '{"label":null}', '{"label":7}', '{"label":true}']
for (const text of inputs) console.log(show(new Label().copy(JSON.parse(text)).label))
const fresh = new Label()
console.log(show(fresh.label), fresh.label.length)
//! expect: string:literal
//! expect: string:x
//! expect: undefined:undefined
//! expect: object:null
//! expect: number:7
//! expect: boolean:true
//! expect: string:none 4
export {}
