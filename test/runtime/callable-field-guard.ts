//! expect: 5 12 7 15
//! expect: 14 24
//! emitted-has: .callKnown<

function plus(value: number): number {
  return value + 1
}
function times(value: number): number {
  return value * 3
}
const operations = { apply: plus }
function run(value: number): number {
  return operations.apply(value)
}
const first = run(4)
operations.apply = times
const second = run(4)

function captured(offset: number): (value: number) => number {
  return (value: number): number => value + offset
}
operations.apply = captured(3)
const third = run(4)
operations.apply = captured(11)
console.log(first, second, third, run(4))

function makeOperations(offset: number): { apply: (value: number) => number } {
  return { apply: (value: number): number => value + offset }
}
function useOperations(held: { apply: (value: number) => number }): number {
  return held.apply(4)
}
console.log(useOperations(makeOperations(10)), useOperations(makeOperations(20)))
