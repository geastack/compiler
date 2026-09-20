//! expect: 0 3 8
//! expect: 3 7 3 false true
//! expect: 6 7 7 7
//! expect: 3 7 4 17 false
//! expect: 8 34
//! expect: 7 7
// Tuple rest is one fresh container, including through callable aliases.
function empty(...args: []): number {
  return args.length
}
function singleton(...args: [number]): number {
  return args[0]
}
function pair(label: string, ...args: [number, number]): number {
  return label.length + args[0] + args[1]
}
function optional(...args: [number, number?]): number {
  return args[0] + (args[1] ?? 0)
}
function hasOptional(...args: [number, number?]): boolean {
  return 1 in args
}
function heterogeneous(...args: [string, number]): number {
  return args[0].length + args[1]
}
function destructured(...[a, b]: [number, number]): number {
  return a + b
}
type Pair = [number, number]
function mutate(...args: Pair): Pair {
  args[0] += args[1]
  return args
}
function generic<T extends [number, number]>(...args: T): number {
  return args[0] + args[1]
}
const arrow = (...args: [number, number]): number => args[0] + args[1]
const alias: (...args: Pair) => Pair = mutate
console.log(empty(), singleton(3), pair('x', 3, 4))
console.log(optional(3), optional(3, 4), optional(3, undefined), hasOptional(3), hasOptional(3, undefined))
console.log(heterogeneous('ab', 4), destructured(3, 4), arrow(3, 4), generic(3, 4))
const input: Pair = [3, 4]
const escaped = alias(...input)
const second = alias(8, 9)
console.log(input[0], escaped[0], escaped[1], second[0], escaped === second)
let order = 0
function tick(value: number): number {
  order = order * 10 + value
  return value
}
console.log(pair('x', tick(3), tick(4)), order)
function add(a: number, b: number): number {
  return a + b
}
const partial = add.bind(undefined, 3)
const complete = add.bind(undefined, 3, 4)
console.log(partial(4), complete())
