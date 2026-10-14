//! expect: top steps 2 out 3
//! expect: local yields-first 3
//! expect: local counted 3 3 2
//! expect: local objects 3 0,1,2
//! expect: index-writes 4 10,11,12,13
//! expect: splice 2,3,9
//! expect: truncate 0 then 1 7
//! expect: nested 6 0,1,2,10,11,12
//! expect: async 3 0,1,2
// A generator mutating an array its caller passed in, drained by
// `while (!it.next().done) {}` -- the empty-bodied drive loop a game's
// instance-culling pass uses. The empty body was the defect, not the
// generator: the loop ran its test once, so only the mutations made before the
// first `yield` survived. Every mutation after any resumption must reach the
// caller's array.
const registry = new Set<number>()

function* fill(out: number[], tag: number): Generator<void, void, void> {
  for (let i = 0; i < 3; i++) {
    if (i % 2 === 0) yield
    out.push(i)
    registry.add(tag * 10 + i)
  }
}

const topOut: number[] = []
const topWork = fill(topOut, 0)
let topSteps = 0
while (!topWork.next().done) topSteps++
console.log(`top steps ${topSteps} out ${topOut.length}`)

function yieldsFirst(): number {
  const local: number[] = []
  const work = fill(local, 1)
  while (!work.next().done) {}
  return local.length
}
console.log(`local yields-first ${yieldsFirst()}`)

function counted(): string {
  const local: number[] = []
  const work = fill(local, 2)
  let steps = 0
  while (!work.next().done) steps++
  return `${local.length} ${registry.size - 6} ${steps}`
}
console.log(`local counted ${counted()}`)

function* fillObjects(out: Array<{ v: number }>): Generator<void, void, void> {
  for (let i = 0; i < 3; i++) {
    if (i === 1) yield
    out.push({ v: i })
  }
}
function objects(): string {
  const local: Array<{ v: number }> = []
  const work = fillObjects(local)
  while (!work.next().done) {}
  return `${local.length} ${local.map((o) => o.v).join(',')}`
}
console.log(`local objects ${objects()}`)

function* writeAt(out: number[]): Generator<void, void, void> {
  for (let i = 0; i < 4; i++) {
    yield
    out[i] = 10 + i
  }
}
function indexWrites(): string {
  const local: number[] = []
  const work = writeAt(local)
  while (!work.next().done) {}
  return `${local.length} ${local.join(',')}`
}
console.log(`index-writes ${indexWrites()}`)

function* spliceIn(out: number[]): Generator<void, void, void> {
  yield
  out.splice(0, 1)
  yield
  out.splice(out.length, 0, 9)
}
function splice(): string {
  const local = [1, 2, 3]
  const work = spliceIn(local)
  while (!work.next().done) {}
  return local.join(',')
}
console.log(`splice ${splice()}`)

function* truncateThenPush(out: number[]): Generator<number, void, void> {
  yield out.length
  out.length = 0
  yield out.length
  out.push(7)
}
function truncate(): string {
  const local = [4, 5, 6]
  const work = truncateThenPush(local)
  let seen = -1
  for (let step = work.next(); !step.done; step = work.next()) seen = step.value
  return `${seen} then ${local.length} ${local[0]}`
}
console.log(`truncate ${truncate()}`)

function* inner(out: number[], base: number): Generator<void, void, void> {
  for (let i = 0; i < 3; i++) {
    yield
    out.push(base + i)
  }
}
function* outer(out: number[]): Generator<void, void, void> {
  for (const base of [0, 10]) {
    const work = inner(out, base)
    while (!work.next().done) yield
  }
}
function nested(): string {
  const local: number[] = []
  const work = outer(local)
  while (!work.next().done) {}
  return `${local.length} ${local.join(',')}`
}
console.log(`nested ${nested()}`)

async function* fillLater(out: number[]): AsyncGenerator<void, void, void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve()
    yield
    out.push(i)
  }
}
async function drainAsync(): Promise<string> {
  const local: number[] = []
  const work = fillLater(local)
  while (!(await work.next()).done) {}
  return `${local.length} ${local.join(',')}`
}
void drainAsync().then((text) => console.log(`async ${text}`))
