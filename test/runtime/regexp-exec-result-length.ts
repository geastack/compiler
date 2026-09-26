// `m.length` on both regular-expression results: each is an Array
// (ECMA-262 22.2.7.2, 22.1.3.13), and `length` is the inherited
// `ArrayObject::length()` of the exec result and the match result alike.
const re = /(\d+)(?:-(\d+))?/
for (const text of ['12-34', '5', 'none']) {
  const m = re.exec(text)
  console.log(text, m === null ? 'null' : `${m.length} ${m.index} ${m[0]}`)
}
const all = 'a1b22c333'.match(/\d+/g)
console.log(all === null ? 'null' : `${all.length} ${all[2]}`)
//! expect: 12-34 3 0 12-34
//! expect: 5 3 0 5
//! expect: none null
//! expect: 3 333
