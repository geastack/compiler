//! expect: plain 1 2 3
//! expect: nul 10 20 2
//! expect: loop 3000
// A constant key read off a string-keyed table is spelled as a string literal,
// and the read takes the key's length from the literal itself: measuring it at
// run time cost a strlen per read (three's uniform tables are read this way
// for every material every frame) and stopped at an embedded NUL, so a key
// holding one read the entry of its prefix instead.

const table: Record<string, number> = {}
const keys = ['diffuse', 'opacity', 'projectionMatrix']
keys.forEach((key, index) => {
  table[key] = index + 1
})
console.log('plain ' + table['diffuse'] + ' ' + table['opacity'] + ' ' + table['projectionMatrix'])

const nul: Record<string, number> = {}
nul['a'] = 10
nul['a\u0000b'] = 20
console.log('nul ' + nul['a'] + ' ' + nul['a\u0000b'] + ' ' + Object.keys(nul).length)

let sum = 0
for (let i = 0; i < 1000; i++) sum += table['diffuse']! + table['opacity']!
console.log('loop ' + sum)
