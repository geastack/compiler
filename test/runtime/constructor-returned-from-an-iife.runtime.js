// @ts-nocheck
//! dynamic-fallback
//! expect: 1.2.3.4 true 4
// ipaddr's `ipaddr.IPv4 = (function () { function IPv4 (octets) { ... }
// ... return IPv4 })()`: the constructor comes back out of an immediately
// invoked function as a box and is stored where a function with both
// `[[Call]]` and `[[Construct]]` is expected, then constructed through.
const ipaddr = {}
ipaddr.IPv4 = (function () {
  function IPv4 (octets) {
    this.octets = octets
  }
  IPv4.prototype.toString = function () {
    return this.octets.join('.')
  }
  return IPv4
})()
ipaddr.IPv4.parse = function (text) {
  return new this(text.split('.').map((part) => Number(part)))
}
const address = ipaddr.IPv4.parse('1.2.3.4')
console.log(address.toString(), address instanceof ipaddr.IPv4, address.octets.length)
