//! expect: first:2
//! expect: second:3
//! expect: third:4
//! expect: total=11

const runHoistedChain = (seed: number): number => {
  let total = seed

  return first(seed)

  function first(value: number): number {
    console.log('first:' + value)
    total += value
    return second(value + 1)
  }

  function second(value: number): number {
    console.log('second:' + value)
    total += value
    return third(value + 1)
  }

  function third(value: number): number {
    console.log('third:' + value)
    total += value
    return total
  }
}

console.log('total=' + runHoistedChain(2))
