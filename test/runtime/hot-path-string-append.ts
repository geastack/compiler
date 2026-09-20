// `s += piece` on a string local must append in place. Spelled as
// `s = concat(s, piece)` the left operand is copied first -- one full copy of
// the accumulated string per iteration, quadratic in the loop -- which is how
// `bench/comparison/fixtures/string_concat.ts` came to spend 80 ms on a loop
// node finishes in 7.
let s = ''
for (let i = 0; i < 20000; i++) {
  s += 'a'
  s += String(i % 10)
}
console.log(s.length, s.slice(0, 12), s.slice(-8))
