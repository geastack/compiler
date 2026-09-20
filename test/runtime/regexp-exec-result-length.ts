// `m.length` on a `RegExpExecArray` rendered `->length()` -- the inherited
// `ArrayObject::length()` of the MATCH result -- but `ExecResult` keeps
// `length` as a data member beside `index` and `input`, so clang refused the
// call on a `double`. The match result keeps its method.
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
