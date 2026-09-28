// @ts-nocheck
//! dynamic-fallback
//! expect: 2 b 1 2 true
// rfdc's `new Map(cloneArray(Array.from(o), fn))`: an Array of boxed entries
// seeds the collection through the iteration protocol.
const pairs = JSON.parse('[["a",1],["b",2]]')
const list = [pairs[0], pairs[1]]
const m = new Map(list)
const s = new Set([JSON.parse('1'), JSON.parse('1'), JSON.parse('"x"')])
console.log(m.size, [...m.keys()][1], m.get('a'), s.size, s.has(1))
