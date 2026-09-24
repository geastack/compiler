// ECMA-262 gives every loop iteration its own lexical environment, and a
// closure keeps the one it was created in. A `for` head's `let` is copied into
// a fresh cell before each incrementor (CreatePerIterationEnvironment,
// 14.7.4.4); a `for`-`of`/`for`-`in` head and a body declaration are created
// afresh each time. `for (let i = 0; i < 3; i++) fns.push(() => i)` printed
// `3 3 3` for every closure sharing one cell, where Node prints `0 1 2`, and
// at module scope every block-scoped cell of a loop was one file-scope global.
//! expect: top-for 0 1 2
//! expect: top-for-of 1 2 3
//! expect: top-body 0 1 2
//! expect: fn-for 0 1 2
//! expect: body-mutates 1 3 5
//! expect: condition 1 2 3
//! expect: update 2 3 3
//! expect: continue 0 2 4
//! expect: nested 00 01 10 11
//! expect: outer-in-inner 0 0 1 1
//! expect: initializer 0 3
//! expect: for-of-let a12 b12 c12
//! expect: for-in-let a! b! c!
//! expect: while-body 0 1 2
//! expect: shared-within 3 3
//! expect: uncaptured 3
//! emitted-has: gea::makeRef<double>((*

const show = (fns: Array<() => number | string>): string => fns.map((f) => f()).join(' ')

const topFor: Array<() => number> = []
for (let i = 0; i < 3; i++) topFor.push(() => i)
console.log('top-for', show(topFor))

const topForOf: Array<() => number> = []
for (const x of [1, 2, 3]) topForOf.push(() => x)
console.log('top-for-of', show(topForOf))

const topBody: Array<() => number> = []
for (let i = 0; i < 3; i++) {
  const j = i
  topBody.push(() => j)
}
console.log('top-body', show(topBody))

function forInFunction(): string {
  const fns: Array<() => number> = []
  for (let i = 0; i < 3; i++) fns.push(() => i)
  return show(fns)
}
console.log('fn-for', forInFunction())

// The body writes the cell after the closure took it: that iteration's cell.
function bodyMutates(): string {
  const fns: Array<() => number> = []
  for (let i = 0; i < 6; i++) {
    fns.push(() => i)
    i++
  }
  return show(fns)
}
console.log('body-mutates', bodyMutates())

// A closure made in the test sees the iteration the test ran in, and the
// incrementor of that iteration's successor runs in a fresh copy.
function inCondition(): string {
  const fns: Array<() => number> = []
  for (let i = 0; fns.push(() => i) > 0 && i < 3; i++) {}
  return show(fns.slice(1))
}
console.log('condition', inCondition())

// The incrementor runs after the copy, so its closure sees the next iteration,
// which that iteration's body then writes.
function inUpdate(): string {
  const fns: Array<() => number> = []
  for (let i = 0; i < 3; fns.push(() => i)) i++
  return show(fns)
}
console.log('update', inUpdate())

function withContinue(): string {
  const fns: Array<() => number> = []
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 1) continue
    fns.push(() => i)
  }
  return show(fns)
}
console.log('continue', withContinue())

function nested(): string {
  const fns: Array<() => string> = []
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) fns.push(() => `${i}${j}`)
  return show(fns)
}
console.log('nested', nested())

function outerInInner(): string {
  const fns: Array<() => number> = []
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) fns.push(() => i)
  }
  return show(fns)
}
console.log('outer-in-inner', outerInInner())

// The copy before the first test leaves a closure in the initializer the
// initializer's own cell, which no iteration writes.
function inInitializer(): string {
  let first: () => number = () => -1
  let last: () => number = () => -1
  for (let i = 0, f = (): number => i; i < 3; i++) {
    first = f
    last = () => i
  }
  return `${first()} ${last() + 1}`
}
console.log('initializer', inInitializer())

function forOfLet(): string {
  const fns: Array<() => string> = []
  for (let x of ['a', 'b', 'c']) {
    x = x + '1'
    fns.push(() => x)
    x = x + '2'
  }
  return show(fns)
}
console.log('for-of-let', forOfLet())

function forInLet(): string {
  const fns: Array<() => string> = []
  const keys: Record<string, number> = { a: 1, b: 2, c: 3 }
  for (let k in keys) {
    fns.push(() => k)
    k = k + '!'
  }
  return show(fns)
}
console.log('for-in-let', forInLet())

const whileBody: Array<() => number> = []
let n = 0
while (n < 3) {
  const m = n
  whileBody.push(() => m)
  n++
}
console.log('while-body', show(whileBody))

// Two closures of one iteration share that iteration's cell.
function sharedWithin(): string {
  const reads: Array<() => number> = []
  for (let i = 0; i < 1; i++) {
    const bump = (): void => {
      i += 3
    }
    reads.push(() => i)
    bump()
    reads.push(() => i - 1)
  }
  return `${reads[0]!()} ${reads[1]!() + 1}`
}
console.log('shared-within', sharedWithin())

function uncaptured(): number {
  let total = 0
  for (let i = 0; i < 3; i++) total += 1
  return total
}
console.log('uncaptured', uncaptured())
