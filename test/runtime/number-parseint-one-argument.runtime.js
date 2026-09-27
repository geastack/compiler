// @ts-nocheck
//! expect: 12 -1 31 8
// A one-argument Number.parseInt, as three's GLSLNodeFunction writes it: the
// radix is absent, so a `0x` prefix still reads as hex.
function parse(text) {
  const count = Number.parseInt(text)
  return Number.isNaN(count) ? -1 : count
}
console.log(parse('12') + ' ' + parse('x') + ' ' + parse('0x1f') + ' ' + Number.parseInt('10', 8))
