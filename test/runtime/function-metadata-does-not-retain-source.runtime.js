// @ts-nocheck
//! expect: calculate 1 7332
//! emitted-lacks: return x + 7331
// Reading metadata must not include the original function declaration in C++.
function calculate(x) {
  return x + 7331
}
console.log(calculate.name, calculate.length, calculate(1))
