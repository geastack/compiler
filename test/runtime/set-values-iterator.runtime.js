// @ts-nocheck
//! expect: 2 a b | 1 | 3 a b c | a b c
// `set.values()` and `set.keys()` are the Set's own cursor (ECMA-262 24.2.3.8,
// 24.2.3.11), walked here by `for`-`of` and by `Array.from`. three's
// RenderObject copies its vertex buffers with `Array.from( set.values() )`.
class Buffer {
  constructor(name) {
    this.name = name
  }
}
/** @type {Set<Buffer>} */
const set = new Set()
const a = new Buffer('a')
set.add(a)
set.add(new Buffer('b'))
set.add(a)
const copied = Array.from(set.values())
const names = []
for (const key of set.keys()) if (key !== a) names.push(key.name)
set.add(new Buffer('c'))
const cursor = set.values()
const walked = []
for (const buffer of cursor) walked.push(buffer.name)
console.log(
  copied.length,
  copied[0].name,
  copied[1].name,
  '|',
  names.length,
  '|',
  walked.length,
  walked.join(' '),
  '|',
  Array.from(set.values())
    .map((b) => b.name)
    .join(' ')
)
