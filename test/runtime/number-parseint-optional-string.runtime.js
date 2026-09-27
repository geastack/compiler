// @ts-nocheck
//! expect: 7 NaN NaN 86464843759093
// An element read that may be a hole reaches `Number.parseInt` as an optional
// string (three's GLSLNodeFunction parses `propsMatches[i][0]`). The absent
// element is `undefined`, so it parses as the string "undefined": NaN in base
// 10, a number in base 36.
const parts = ['7', 'x']
const out = []
for (let i = 0; i < 3; i++) out.push(Number.parseInt(parts[i]))
out.push(Number.parseInt(parts[out.length], 36))
console.log(out.join(' '))
