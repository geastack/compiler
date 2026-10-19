// `for (const [unit, size] of [['GiB', 2 ** 30], ...] as const)` iterates a
// readonly array literal whose elements are readonly tuples. `as const` makes
// the iterable a readonly tuple of tuples, which is still an array and still
// has Array.prototype[Symbol.iterator]; destructuring each element must read
// its two slots in order, for number and for bigint sizes alike.
//! expect: 1.5 GiB
//! expect: 2.0 MiB
//! expect: 512 B
//! expect: 3.1 GiB
//! expect: 7.0 KiB
//! expect: 9 B
export {}

const formatNumber = (value: number): string => {
  for (const [unit, size] of [
    ['GiB', 1073741824],
    ['MiB', 1048576],
    ['KiB', 1024]
  ] as const)
    if (value >= size) return `${(value / size).toFixed(1)} ${unit}`
  return `${value} B`
}

const formatBigInt = (value: bigint): string => {
  for (const [unit, size] of [
    ['GiB', 1073741824n],
    ['MiB', 1048576n],
    ['KiB', 1024n]
  ] as const)
    if (value >= size) {
      const tenths = (value * 10n) / size
      return `${tenths / 10n}.${tenths % 10n} ${unit}`
    }
  return `${value} B`
}

console.log(formatNumber(1610612736))
console.log(formatNumber(2097152))
console.log(formatNumber(512))
console.log(formatBigInt(3435973836n))
console.log(formatBigInt(7168n))
console.log(formatBigInt(9n))
