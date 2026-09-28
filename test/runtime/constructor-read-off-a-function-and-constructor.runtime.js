// @ts-nocheck
//! dynamic-fallback
//! expect: 10.0.0.1 true 1.2.3.4
// ipaddr's `new ipaddr.IPv4([...])` from a method of `ipaddr.IPv6`: the
// module object holds IPv4 as a function that is also a constructor, and the
// `new` reads only its construct half.
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
ipaddr.IPv6 = (function () {
  function IPv6 (parts) {
    this.parts = parts
  }
  IPv6.prototype.toIPv4Address = function () {
    const ref = this.parts.slice(-2)
    return new ipaddr.IPv4([ref[0] >> 8, ref[0] & 0xff, ref[1] >> 8, ref[1] & 0xff])
  }
  return IPv6
})()
const v4 = new ipaddr.IPv6([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]).toIPv4Address()
console.log(String(v4), v4 instanceof ipaddr.IPv4, String(new ipaddr.IPv4([1, 2, 3, 4])))
