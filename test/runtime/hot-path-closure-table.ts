// The closure-table loop from `bench/comparison/fixtures/closure.ts`, sized
// for a test. Every iteration allocates one closure and calls another through
// a table slot, and NOTHING here observes a closure's identity: no `===`
// between functions, no function used as a Map/Set key, no property read off a
// function. So no iteration may mint a `FunctionObjectIdentity` (a heap object
// plus its `properties` table) -- the September regression that made this loop
// slower than node did exactly that, once per closure copy.
type NumberFn = (x: number) => number

function makeAdder(base: number): NumberFn {
  return (x: number) => base + x
}
function makeSubtractor(base: number): NumberFn {
  return (x: number) => x - base
}
function makeInverter(base: number): NumberFn {
  return (x: number) => base - x
}
function makeBumper(base: number): NumberFn {
  return (x: number) => base + x + 1
}
function makeKind(kind: number, base: number): NumberFn {
  if (kind === 0) return makeAdder(base)
  if (kind === 1) return makeSubtractor(base)
  if (kind === 2) return makeInverter(base)
  return makeBumper(base)
}

// Inside a function, as the benchmark has it: `fns` and `f` are then frame
// locals, which is what lets the table get a dense window and lets `f`'s cell
// disappear into the call (`ir/deferral.ts`'s forwarded bindings) -- a module
// cell may be read by any body, so neither applies to one.
function main(iterations: number): number {
  const fns: NumberFn[] = []
  for (let i = 0; i < 16; i++) fns.push(makeKind(i % 4, i))
  let total = 0
  for (let i = 0; i < iterations; i++) {
    const slot = i % 16
    fns[slot] = makeKind(i % 4, i)
    const f = fns[(slot + 1) % 16]!
    total += f(i)
  }
  return total % 1000000000
}

console.log(main(20000))
