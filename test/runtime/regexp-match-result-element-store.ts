// A match result IS an Array (ECMA-262 22.1.3.13 builds one and then adds
// `index`/`input`/`groups`), so a program may write a capture slot. hono's
// `Trie.insert` does: it tokenizes with `path.match(re) || []` -- a union that
// collapses to the match result alone, since an empty array literal names no
// value the other arm does not already hold -- and then rewrites the token it
// just scanned in place.
//! expect: a|X|c
//! expect: 4:/:id/Y
const scanned = 'abc'.match(/./g) || []
scanned[1] = 'X'
console.log(scanned.join('|'))

// The computed-key store, which is the shape hono writes.
const tokens = '/:id/x'.match(/(?::[^/]+)|./g) || []
for (let i = tokens.length - 1; i >= 0; i--) {
  if (tokens[i]! === 'x') {
    tokens[i] = 'Y'
    break
  }
}
console.log(`${tokens.length}:${tokens.join('')}`)
