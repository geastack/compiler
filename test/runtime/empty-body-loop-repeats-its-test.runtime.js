// @ts-nocheck
//! expect: 0 -1 1 3 2
// A head-tested loop whose body is empty repeats its test until it fails:
// the side effects live in the condition (dequal's
// `while (len-- && dequal(foo[len], bar[len]));`).
function same (a, b) { return a === b }
function matches (xs, ys) {
  var len
  if ((len = xs.length) === ys.length) { while (len-- && same(xs[len], ys[len])); }
  return len
}
var n = 3
while (n-- && n > 0);
var i = 0
for (; i < 3; i++);
var j = 0
while (j < 5) { if (++j === 2) break }
console.log(n, matches([1, 2], [1, 2]), matches([1, 2], [1, 3]), i, j)
