// @ts-nocheck
//! expect: 1 1
//! expect: a1
//! expect: a111a010
// A collection a function fills and returns is the one its callers hold: the
// cell a call initializes, and the parameter a call's result fills, carry the
// element types the census joined for the local (safe-stable-stringify's
// `getUniqueReplacerSet`, handed to the recursive `stringifyArrayReplacer`).
function makeMap () { const m = new Map(); m.set('a', 1); return m }
const x = makeMap()
console.log(x.get('a'), x.size)
function unique (items) {
  const seen = new Set()
  for (const value of items) {
    if (typeof value === 'string' || typeof value === 'number') seen.add(String(value))
  }
  return seen
}
function show (keys) { let out = ''; for (const k of keys) out += k; return out }
console.log(show(unique(['a', 1])))
function walk (keys, depth) {
  let out = ''
  for (const key of keys) out += key + depth
  return depth > 0 ? out + walk(keys, depth - 1) : out
}
console.log(walk(unique(['a', 1, {}, 'a']), 1))
