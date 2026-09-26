//! dynamic-fallback
//! expect: Rho Beta Rho Beta  | |  Rho Beta   RHO BETA     rho beta   12
//! expect: a|b||c a|b a|b|c 2 4 true
//! expect: x+1-y-2 x+1+y+2 x[1]-y[2] x-<1>-y-<2>
//! expect: true true bc bc ab b b 97 c
//! expect: ***abc abc   abcabc abcd1 c 2 -1
//! expect: 3.14 ff 3.14 255 1.2e+3
//! expect: bc c true 1 abc 3 true
//! expect: 2024 05 3 true
// Strings and numbers that only reach the program as dynamic values still
// answer their prototype's methods.
'use strict'
const v = JSON.parse('["  Rho Beta  ", "a,b,,c", "x-1-y-2", 3.14159, 255, "abc", "2024-05-06", "x"]')
const s = v[0], csv = v[1], dash = v[2], pi = v[3], n = v[4], abc = v[5], date = v[6], x = v[7]
console.log(s.trim(), s.trimStart() + '|', '|' + s.trimEnd(), s.toUpperCase(), s.toLowerCase(), s.length)
console.log(csv.split(',').join('|'), csv.split(',', 2).join('|'), csv.split(/,+/).join('|'), csv.indexOf('b'), csv.lastIndexOf(','), csv.includes(',,'))
console.log(dash.replace('-', '+'), dash.replaceAll('-', '+'), dash.replace(/-(\d)/g, (m, d) => '[' + d + ']'), dash.replace(/(\d)/g, '<$1>'))
console.log(abc.startsWith('ab'), abc.endsWith('bc'), abc.slice(1), abc.slice(-2), abc.substring(2, 0), abc.substr(1, 1), abc.charAt(1), abc.charCodeAt(0), abc.at(-1))
console.log(abc.padStart(6, '*'), abc.padEnd(5), abc.repeat(2), abc.concat('d', 1), abc.match(/b(c)/)[1], abc.search('c'), abc.localeCompare('abd'))
console.log(pi.toFixed(2), n.toString(16), pi.toPrecision(3), n.toString(), (1234.5).toExponential(1))
const m = abc.match(/b(c)?(z)?/)
console.log(m[0], m[1], m[2] === undefined, m.index, m.input, m.length, m.groups === undefined)
const d = date.match(/(?<y>\d+)-(?<mo>\d+)/)
console.log(d.groups.y, d.groups.mo, date.match(/\d+/g).length, x.match(/q/) === null)
