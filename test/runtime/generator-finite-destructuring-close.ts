//! expect: partial:1:partial-close
//! expect: exhausted:1,undefined:1
//! expect: default:default-close:default-failure
//! expect: normal-close:normal-close-failure
//! expect: elision:elision-close
//! expect: nested:7:outer-closeinner-close,
//! expect: empty:true
//! emitted-has: resumeReturn
//! emitted-has: gea::runtime::iterator::CompletionGuard

let partialState = 'partial-open'
function* partialGenerator(): Generator<number> {
  try {
    yield 1
    yield 2
  } finally {
    partialState = 'partial-close'
  }
}
const [partial] = partialGenerator()
console.log(`partial:${partial}:${partialState}`)

// The second step observes done=true after the generator's finally has run.
// The finite cleanup guard must not call return() again on that exhausted
// cursor; the single finally execution is the observable count.
let exhaustedFinallys = 0
function* exhaustedGenerator(): Generator<number> {
  try {
    yield 1
  } finally {
    exhaustedFinallys += 1
  }
}
const [exhaustedHead, exhaustedTail] = exhaustedGenerator()
console.log(`exhausted:${exhaustedHead},${exhaustedTail}:${exhaustedFinallys}`)

const throwDefault = (): number => {
  throw 'default-failure'
}
let defaultState = 'default-open'
function* defaultGenerator(): Generator<undefined> {
  try {
    yield undefined
  } finally {
    defaultState = 'default-close'
    throw 'close-must-not-replace-default'
  }
}
try {
  const [defaulted = throwDefault()] = defaultGenerator()
  console.log(defaulted)
} catch (error) {
  // A pending throw completion wins over a failure from iterator.return().
  console.log(`default:${defaultState}:${error}`)
}

function* normalCloseGenerator(): Generator<number> {
  try {
    yield 1
    yield 2
  } finally {
    throw 'normal-close-failure'
  }
}
try {
  const [normalCloseValue] = normalCloseGenerator()
  console.log(normalCloseValue)
} catch (error) {
  // With no pending throw, a failing return() replaces normal completion.
  console.log(`normal-close:${error}`)
}

let elisionState = 'elision-open'
function* elisionGenerator(): Generator<number> {
  try {
    yield 1
    yield 2
  } finally {
    elisionState = 'elision-close'
  }
}
const [,] = elisionGenerator()
console.log(`elision:${elisionState}`)

let nestedCloseOrder = ''
function* innerGenerator(): Generator<number> {
  try {
    yield 7
    yield 8
  } finally {
    nestedCloseOrder += 'inner-close,'
  }
}
function* outerGenerator(): Generator<Generator<number>> {
  try {
    yield innerGenerator()
    yield innerGenerator()
  } finally {
    nestedCloseOrder += 'outer-close'
  }
}
// A literal `[[nestedValue]] = outerGenerator()` fails `noUncheckedIndexedAccess`:
// TS types a nested array-pattern element `Generator<number> | undefined`
// (TS2488, checked against plain tsc, unrelated to this compiler) even though
// `outerGenerator` never yields `undefined`. Splitting the destructuring into
// two statements with a non-null assertion keeps the exact same IteratorClose
// sequence -- one step of the outer generator, then a finite destructure of
// the yielded inner one -- while being valid TypeScript.
//
// The OUTER generator therefore closes first: its destructuring completes --
// and IteratorCloses it -- before the inner one it yielded is destructured at
// all. This directive used to read `inner-close,outer-close`, which no engine
// produces and which the C++ program could not have produced either; it was
// never observed failing because the whole program aborted before reaching
// this line (`emit-exceptions.ts`'s `finallyGuardType`). Node prints
// `nested:7:outer-closeinner-close,` and so does the emitted program, line for
// line across all seven.
const [outerValue] = outerGenerator()
const [nestedValue] = outerValue!
console.log(`nested:${nestedValue}:${nestedCloseOrder}`)

// Returning a generator in suspended-start state does not enter its body, but
// it must still close the iterator. A subsequent next() therefore reports
// done=true rather than yielding the first value.
// Annotated `Generator<number, void>` (not the implicit `Generator<number>`,
// whose TReturn defaults to `any`): `emptyIterator.next()` below reads the
// IteratorResult's completion-value field directly, and this compiler does
// not yet support a dynamic (declared-any-never-narrowed) generator
// completion channel (`src/representation/derive.ts`'s `nativeOrUndefined`
// collapses ANY dynamic/unresolved TReturn to `{kind:'undefined'}`, a
// documented, intentional gap, not something to route around here). This
// generator never explicitly returns a value, so `void` is both accurate and
// sidesteps the unimplemented capability without changing any observed
// behavior.
function* emptyGenerator(): Generator<number, void> {
  yield 1
}
const emptyIterator = emptyGenerator()
const [] = emptyIterator
console.log(`empty:${emptyIterator.next().done}`)
