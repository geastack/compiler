const low = BigInt(1)
const high = BigInt(-1 >>> 0)
const signed = BigInt.asIntN(64, (high << 32n) + low)
console.log(signed.toString(), BigInt.asUintN(64, -1n).toString())
console.log((2n ** 128n + 3n).toString(), (-17n / 3n).toString(), (-17n % 3n).toString())
console.log((~5n).toString(), (-17n >> 2n).toString(), (9n << -1n).toString())
console.log(BigInt('  0xff  ').toString(16), BigInt(true).toString(), Number(9007199254740993n))
console.log(1n < 2n, 2n === 2n, Boolean(0n), Boolean(1n))
console.log((0xffn + 1_000n).toString(), BigInt('9007199254740993') > BigInt('9007199254740992'))
let counter = 1n
console.log(counter++, counter)
let errors = 0
try {
  BigInt(1.5)
} catch {
  errors++
}
try {
  BigInt('bad')
} catch {
  errors++
}
try {
  const divisor = BigInt(0)
  console.log(1n / divisor)
} catch {
  errors++
}
console.log(errors)
