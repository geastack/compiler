// @ts-nocheck
//! expect: 1 2 1
function* g() {
  yield 1
  yield 2
  yield 3
}
function makeGen() {
  return g()
}
const makeArrow = () => g()
var [a, b] = makeGen()
var [c] = makeArrow()
console.log(a, b, c)
