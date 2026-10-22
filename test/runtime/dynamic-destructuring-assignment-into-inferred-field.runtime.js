// @ts-nocheck
// A destructuring assignment whose target is the field itself,
// `({ label: this.label } = source)`, stores the source's member -- absent,
// here -- into a field typed only by its constructor write.
const show = (value) => `${typeof value}:${value}`
class Tag {
  constructor() {
    this.label = 'none'
    this.weight = 1
  }
  load(source) {
    ;({ label: this.label, weight: this.weight } = source)
    return this
  }
}
const tag = new Tag().load(JSON.parse('{"weight":null}'))
console.log(show(tag.label), show(tag.weight))
//! expect: undefined:undefined object:null
export {}
