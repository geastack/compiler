// A cursor advanced by int32 lengths read out of a buffer (a binary-document parser's
// `index += size`) grows by up to 2^32 a turn: too fast for the exact integer cap,
// slow enough for the 64-bit carrier. It is narrowed, and once its integer
// answer leaves +-2^53 each step rounds exactly as the Number does. A
// modular product (`acc * i % MOD` past i = 2^53 / MOD) is the same rounding
// through a multiplication, and its remainder must be the rounded Number's.
//! expect: 9007199254740000 9007199254740991 9007201402224638 9007201402224640 4
//! expect: 3628800 35722381
//! emitted-has: gea::faithfulIntegerSum(
//! emitted-has: gea::faithfulIntegerProduct(

function advance(lengths: Int32Array, start: number, turns: number): number {
  let offset = start
  for (let turn = 0; turn < turns; turn++) offset += lengths[turn % lengths.length]! | 0
  return offset
}

const lengths = new Int32Array([991, 2147483647, 1, 1])
const start = 9007199254740000
console.log(
  String(advance(lengths, start, 0)),
  String(advance(lengths, start, 1)),
  String(advance(lengths, start, 2)),
  String(advance(lengths, start, 4)),
  String(advance(lengths, start, 4) - advance(lengths, start, 2) + 2)
)

function modularFactorial(n: number): number {
  const MOD = 1000000007
  let acc = 1
  for (let i = 1; i <= n; i++) acc = (acc * i) % MOD
  return acc
}

console.log(String(modularFactorial(10)), String(modularFactorial(12000000)))
