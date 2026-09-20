//! expect: present
//! expect: absent
//! expect: symbol absent

// hono's trie router writes `key in curNode.#children` where `key` is
// `Array.isArray(pattern) ? pattern[0] : p`. `Array.isArray`'s `arg is any[]`
// filters nothing out of a union whose array member is a READONLY tuple, so
// TypeScript widens the true arm to `any` and the key reaches the string-keyed
// table boxed. The box is the checker's answer, not the program's intent: the
// value really is a string at runtime.
//
// `in` is ToPropertyKey (7.1.19), not ToString, and the two differ on exactly
// one tag. A symbol is a legal `in` key that answers `false` against a table
// with no symbol storage, where ToString of one is a TypeError -- so the key is
// converted first and its tag tested afterwards.
const children: Record<string, number> = Object.create(null)
children['users'] = 1

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const boxedKey = (route: any, fallback: unknown): any => (Array.isArray(route) ? route[0] : fallback)

console.log(boxedKey(['users', 'id'], 'other') in children ? 'present' : 'absent')
console.log(boxedKey(null, 'other') in children ? 'present' : 'absent')
console.log(boxedKey(null, Symbol('users')) in children ? 'symbol present' : 'symbol absent')
