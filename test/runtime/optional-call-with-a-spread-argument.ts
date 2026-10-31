// AN OPTIONAL CALL WITH A SPREAD ARGUMENT.
//
// `fn?.(...a)` evaluates its argument list only when `fn` is present. A
// closed-tuple spread expands to one `[[Get]]` per position, and those reads
// are minted against the CALL rather than against any argument syntax, so the
// syntax walk that places the argument subtree inside the presence test cannot
// see them. They are placed by their own conditional edge, as the call is.
// `callAll` is `@zag-js/utils`'s, with `T | undefined` for its arms.

//! expect: first 1 a
//! expect: second 2 a!
//! expect: absent 0
//! expect: x7 1
//! expect: absent 1
//! expect: rest 6
//! expect: rest 16
//! expect: rest absent
//! expect: guarded 2 b
//! expect: looped 0 c
//! expect: looped 1 c
//! expect: method 10 3
const callAll =
  <T extends (...a: any[]) => void>(...fns: (T | undefined)[]) =>
  (...a: Parameters<T>) => {
    fns.forEach((fn) => {
      fn?.(...a)
    })
  }
callAll(
  (n: number, s: string) => console.log('first', n, s),
  undefined,
  (n: number, s: string) => console.log('second', n + 1, s + '!')
)(1, 'a')

let made = 0
const make = (): [number, string] => {
  made++
  return [7, 'x']
}
const run = (fn: ((n: number, s: string) => string) | undefined): string => fn?.(...make()) ?? 'absent'
console.log(run(undefined), made)
console.log(
  run((n, s) => s + n),
  made
)
console.log(run(undefined), made)

const sum = (...xs: number[]): number => xs.reduce((total, x) => total + x, 0)
const pick = (on: boolean): ((...xs: number[]) => number) | undefined => (on ? sum : undefined)
const values = [1, 2, 3]
console.log('rest', pick(true)?.(...values))
console.log('rest', pick(true)?.(0, ...values, 10))
console.log('rest', pick(false)?.(...values) ?? 'absent')

const inner = (on: boolean, fn: ((n: number, s: string) => void) | undefined, pair: [number, string]): void => {
  if (on) fn?.(...pair)
}
inner(true, (n, s) => console.log('guarded', n, s), [2, 'b'])
inner(false, (n, s) => console.log('never', n, s), [3, 'b'])
const looped = (fn: ((n: number, s: string) => void) | undefined, pairs: [number, string][]): void => {
  for (const pair of pairs) fn?.(...pair)
}
looped(
  (n, s) => console.log('looped', n, s),
  [
    [0, 'c'],
    [1, 'c']
  ]
)
looped(undefined, [[9, 'z']])

class Counter {
  base = 10
  add(n: number): void {
    console.log('method', this.base, n)
  }
}
const counterOf = (on: boolean): Counter | undefined => (on ? new Counter() : undefined)
const argsOf: [number] = [3]
counterOf(true)?.add(...argsOf)
counterOf(false)?.add(...argsOf)
