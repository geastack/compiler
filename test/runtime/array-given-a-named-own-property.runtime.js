// @ts-nocheck
//! dynamic-fallback
//! expect: 10.0.0.1/8 2 10.0.0.1
//! expect: ::1/128 true
// ipaddr's `parseCIDR`: the [address, length] pair gets its own `toString`
// through `Object.defineProperty`, which String() then calls.
function parseCIDR (text) {
  const match = text.match(/^(.+)\/(\d+)$/)
  const parsed = [match[1], parseInt(match[2])]
  Object.defineProperty(parsed, 'toString', {
    value: function () {
      return this.join('/')
    }
  })
  return parsed
}
function parseV6 (text) {
  let parsed
  const match = text.match(/^(.+)\/(\d+)$/)
  parsed = [match[1], parseInt(match[2])]
  Object.defineProperty(parsed, 'toString', { value: function () { return this.join('/') } })
  return parsed
}
const cidr = parseCIDR('10.0.0.1/8')
console.log(String(cidr), cidr.length, cidr[0])
const v6 = parseV6('::1/128')
console.log(String(v6), Object.getOwnPropertyNames(v6).includes('toString'))
