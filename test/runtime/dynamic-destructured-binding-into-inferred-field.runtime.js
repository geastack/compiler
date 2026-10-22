// @ts-nocheck
// A binding destructured out of an object nothing types -- with or without a
// default, in a declaration or a parameter -- holds whatever that object
// holds under the key; the default replaces only `undefined`. Stored into a
// field typed only by its constructor write, the `null` and the number
// aborted in the field's checked unbox.
const show = (value) => `${typeof value}:${value}`
class Caption {
  constructor() {
    this.text = 'none'
    this.size = 1
  }
  load(source) {
    const { text = 'fallback' } = source
    this.text = text
    return this
  }
  resize({ size }) {
    this.size = size
    return this
  }
}
for (const document of ['{"text":null}', '{"text":3}', '{}']) console.log(show(new Caption().load(JSON.parse(document)).text))
console.log(show(new Caption().resize(JSON.parse('{"size":"big"}')).size))
//! expect: object:null
//! expect: number:3
//! expect: string:fallback
//! expect: string:big
export {}
