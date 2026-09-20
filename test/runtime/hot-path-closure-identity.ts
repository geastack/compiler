// The same closure table as `hot-path-closure-table.ts`, but this program DOES
// observe closure identity: it compares two table entries with `===` and keeps
// closures in a `Set`. Those closures must carry a `FunctionObjectIdentity`, so
// `identifyCallable` must be back in the emitted C++ -- the identity census is
// allowed to skip it only when nothing looks.
type NumberFn = (x: number) => number

function makeAdder(base: number): NumberFn {
  return (x: number) => base + x
}
function makeSubtractor(base: number): NumberFn {
  return (x: number) => x - base
}
function makeKind(kind: number, base: number): NumberFn {
  return kind === 0 ? makeAdder(base) : makeSubtractor(base)
}

const fns: NumberFn[] = []
for (let i = 0; i < 8; i++) fns.push(makeKind(i % 2, i))
const seen = new Set<NumberFn>()
let same = 0
let total = 0
for (let i = 0; i < 2000; i++) {
  const slot = i % 8
  if (i % 3 === 0) fns[slot] = makeKind(i % 2, i)
  const f = fns[(slot + 1) % 8]!
  if (i % 5 === 0) fns[slot] = f
  if (f === fns[slot]) same++
  seen.add(f)
  total += f(i)
}
console.log(total, same, seen.size)
