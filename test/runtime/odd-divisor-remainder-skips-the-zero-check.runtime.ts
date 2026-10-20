//! expect: primes=1229
//! expect: negative=-2 -2 -3
//! expect: minByMinusOne=0
//! emitted-has: gea::integerModuloNonZero
// A `%` whose divisor is an integer cell this body proves odd on every path
// cannot divide by zero, so it lowers without `integerModulo`'s zero branch.
// That branch alone kept trial division (`d` starts at 3 and steps by 2) 8%
// behind Rayon: a wrapping induction variable is never provably non-zero to
// clang, so it laid the loop out around the branch. The `MIN % -1` guard
// stays, and an odd negative divisor keeps the dividend's sign.
declare const intBrand: unique symbol
type int = number & { readonly [intBrand]?: never }

const isPrime = (candidate: int): boolean => {
  if (candidate < 2) return false
  if (candidate % 2 === 0) return candidate === 2
  let divisor: int = 3
  while (divisor * divisor <= candidate) {
    if (candidate % divisor === 0) return false
    divisor += 2
  }
  return true
}

const negativeRemainders = (dividend: int): string => {
  const out: string[] = []
  let divisor: int = -3
  for (let turn = 0; turn < 3; turn++) {
    out.push(String(dividend % divisor))
    divisor -= 2
  }
  return out.join(' ')
}

const minByMinusOne = (dividend: int): number => {
  let divisor: int = -1
  return (dividend % divisor) + 0
}

let primes = 0
for (let n: int = 0; n < 10000; n++) if (isPrime(n)) primes++
console.log(`primes=${primes}`)
console.log(`negative=${negativeRemainders(-17)}`)
console.log(`minByMinusOne=${minByMinusOne(-9223372036854775808)}`)
