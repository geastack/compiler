// @ts-nocheck
//! expect: 7 -1 0 8 true false
// ipaddr's `prefixLengthFromSubnetMask`: `octet in zerotable` over a literal
// whose keys are numerals, with the octet a runtime Number. ToPropertyKey is
// the Number's canonical string, which the literal's own members answer and
// which no Object.prototype member ever spells.
const zerotable = { 0: 8, 128: 7, 255: 0 }
const octets = [128, 3, 255, 0]
const found = octets.map((octet) => (octet in zerotable ? zerotable[octet] : -1))
const probe = (key) => key in zerotable
console.log(found.join(' '), probe(0.0), probe(1))
