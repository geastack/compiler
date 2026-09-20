// A function passed as a VALUE into a `(...args: any[]) => void` slot -- the
// JavaScript "some function" idiom. tsc's whole `Debug` family threads itself
// through it: `assertIsDefined(value, message, stackCrawlMark || checkDefined)`
// passes a generic function to a parameter whose declared frame is one rest
// array, and inside a `||` whose other arm is that same parameter.
type AnyFunction = (...args: any[]) => void

let marks = ''

function note(label: string, mark: AnyFunction | undefined): void {
  marks += mark === undefined ? label + ':none ' : label + ':some '
}

function assertIsDefined<T>(value: T, message?: string, mark?: AnyFunction): void {
  note('assert', mark)
  if (value === undefined || value === null) throw new Error(message ?? 'absent')
}

function checkDefined<T>(value: T | null | undefined, message?: string, mark?: AnyFunction): T {
  assertIsDefined(value, message, mark || checkDefined)
  return value as T
}

interface Named {
  name: string
}

// The erased slot is also CALLED, so the positional read out of the rest array
// is exercised rather than only compiled.
function describe(count: number, label: string): void {
  marks += 'described(' + String(count) + ',' + label + ') '
}

function invoke(mark: AnyFunction): void {
  mark(3, 'three')
}

const one: number | undefined = 5
const two: Named | undefined = { name: 'two' }
console.log(checkDefined(one), checkDefined(two).name)
console.log(checkDefined('three', 'missing three'))
invoke(describe)
console.log(marks.trim())
//! expect: 5 two
//! expect: three
//! expect: assert:some assert:some assert:some described(3,three)
