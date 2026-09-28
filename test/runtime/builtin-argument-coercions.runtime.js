// @ts-nocheck
//! expect: 192,255,255 3.5 false true true
// A language builtin coerces its own argument (ECMA-262 19.2.5 parseInt and
// 19.2.4 parseFloat apply ToString, 19.2.3 isNaN and 19.2.2 isFinite apply
// ToNumber), so a program may pass whatever it holds. ipaddr.js's
// `parseInt(octet, 10)` over a number.
'use strict'
const octets = [192, 168, 255]
const masks = [255, 0, 7]
const out = []
for (let i = 0; i < 3; i++) out.push(parseInt(octets[i], 10) | parseInt(masks[i], 10) ^ 255)
console.log(out.join(','), parseFloat(3.5), isNaN('12'), isNaN('x'), isFinite('7'))
