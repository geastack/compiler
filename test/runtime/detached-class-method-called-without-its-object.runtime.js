// @ts-nocheck
//! expect: "x" 2 3 4
// A class method detached from its object -- by destructuring or by a plain
// read into a `const` -- is called with `this` undefined; a body that never
// reads `this` answers the same (fastify's generated error serializer:
// `const { asString, asNumber } = serializer`). The one that reads `this` is
// bound explicitly, as the program writes it.
class Serializer {
  constructor () { this.parseInteger = Math.trunc }
  asInteger (value) { return '' + this.parseInteger(value) }
  asNumber (value) { return '' + value }
  asString (value) { return JSON.stringify(value) }
}
const serializer = new Serializer()
const { asString, asNumber } = serializer
const asInteger = serializer.asInteger.bind(serializer)
const single = serializer.asNumber
console.log(asString('x'), asNumber(2), asInteger(3.7), single(4))
