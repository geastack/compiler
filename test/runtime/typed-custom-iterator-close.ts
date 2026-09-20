//! expect: break-close
//! expect: return-close
//! expect: throw-close
//! expect: typed-body-1
//! expect: typed-close-failure
//! expect: generator-close
//! expect: inner-close,outer-open
//! expect: normal-open
//! expect: typed-next-getter-open:typed-next-getter-failure
//! expect: typed-next-call-open:typed-next-call-failure
//! expect: typed-done-getter-open:typed-done-getter-failure
//! expect: typed-value-getter-open:typed-value-getter-failure
//! emitted-has: gea::runtime::iterator::CompletionGuard

// FIXED by a census of what IMPLEMENTERS prove about a declared member.
//
// An interface's `get next(): T` has no body, so the shape spelled the member
// as ordinary data and the implementing literal's `get next() { ... }` had
// nowhere to install its body -- the record allocated with an unset callable
// slot. `RecordAccessor.getter` is one `FunctionId` and an accessor occupies no
// storage, so "is this member an accessor" is a fact about the TYPE while
// "whose body backs it" is a fact about the ALLOCATION. Keying off the layout
// site would hand every allocation the first implementer's body (shapes are
// interned by type); putting the bodies in the interning key would mint two
// shapes for one declared type that then could not convert to each other. So
// `censusDeclaredMembers` answers program-wide, keyed on the DECLARED member's
// own symbol, and REFUSES when two implementers disagree.

type TypedStep = { value: number; done: boolean }
type TypedCursor = {
  next(): TypedStep
  return(): TypedStep
}
type TypedSource = { [Symbol.iterator](): TypedCursor }

const source = (closed: (text: string) => void): TypedSource => ({
  [Symbol.iterator]() {
    let emitted = false
    return {
      next() {
        if (emitted) return { value: 0, done: true }
        emitted = true
        return { value: 1, done: false }
      },
      return() {
        closed('close')
        return { value: 0, done: true }
      }
    }
  }
})

let breakState = 'break-open'
for (const value of source(() => (breakState = 'break-close'))) {
  if (value === 1) break
}
console.log(breakState)

let returnState = 'return-open'
function leave(): void {
  for (const value of source(() => (returnState = 'return-close'))) {
    if (value === 1) return
  }
}
leave()
console.log(returnState)

let throwState = 'throw-open'
try {
  for (const value of source(() => (throwState = 'throw-close'))) {
    if (value === 1) throw 'body'
  }
} catch {}
console.log(throwState)

const throwingClose: TypedSource = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        throw 'typed-close-failure'
      }
    }
  }
}
try {
  for (const value of throwingClose) throw `typed-body-${value}`
} catch (error) {
  console.log(error)
}
function leaveThrowingClose(): void {
  for (const value of throwingClose) {
    if (value === 1) return
  }
}
try {
  leaveThrowingClose()
} catch (error) {
  console.log(error)
}

let generatorState = 'generator-open'
const generatorSource = {
  *[Symbol.iterator]() {
    try {
      yield 1
    } finally {
      generatorState = 'generator-close'
    }
  }
}
for (const value of generatorSource) {
  if (value === 1) break
}
console.log(generatorState)

let labelState = ''
outer: for (const outerValue of source(() => (labelState += 'outer-close'))) {
  for (const innerValue of source(() => (labelState += 'inner-close,'))) {
    if (outerValue === innerValue) continue outer
  }
}
console.log(labelState === 'inner-close,' ? 'inner-close,outer-open' : labelState)

let normalState = 'normal-open'
const exhausted: TypedSource = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 0, done: true }
      },
      return() {
        normalState = 'normal-close'
        return { value: 0, done: true }
      }
    }
  }
}
for (const value of exhausted) console.log(value)
console.log(normalState)

// IteratorNext, IteratorComplete and IteratorValue all execute in the loop
// header, before the body begins, and they are NOT under the body's
// IteratorClose protection. 14.7.5.7 ForIn/OfBodyEvaluation reaches each of
// them through `?` (ReturnIfAbrupt), which propagates the throw as-is; only
// step 7.b's body evaluation is wrapped in the IteratorClose that steps
// 7.b.ii-iii perform. So all four of these print `-open`, and this file's own
// expectations said `-close` until real node was asked -- V8 agrees with the
// spelling above, and the emitted guard this compiler already writes
// (`if (in_body) close(); else dismiss();`) was correct all along. Corrected
// rather than left failing: a wrong expectation makes a right answer look
// broken, and would have condemned the eventual fix.
//
// These declarations keep every carrier statically typed; none of the cases
// may reach `gea::Value`.
interface TypedNextGetterCursor {
  get next(): () => TypedStep
  return(): TypedStep
}
interface TypedNextGetterSource {
  [Symbol.iterator](): TypedNextGetterCursor
}
let typedNextGetterState = 'typed-next-getter-open'
const typedNextGetterSource: TypedNextGetterSource = {
  [Symbol.iterator]() {
    return {
      get next(): () => TypedStep {
        throw 'typed-next-getter-failure'
      },
      return() {
        typedNextGetterState = 'typed-next-getter-close'
        return { value: 0, done: true }
      }
    }
  }
}
try {
  for (const value of typedNextGetterSource) console.log(value)
} catch (error) {
  console.log(`${typedNextGetterState}:${error}`)
}

let typedNextCallState = 'typed-next-call-open'
const typedNextCallSource: TypedSource = {
  [Symbol.iterator]() {
    return {
      next() {
        throw 'typed-next-call-failure'
      },
      return() {
        typedNextCallState = 'typed-next-call-close'
        return { value: 0, done: true }
      }
    }
  }
}
try {
  for (const value of typedNextCallSource) console.log(value)
} catch (error) {
  console.log(`${typedNextCallState}:${error}`)
}

interface TypedDoneGetterStep {
  readonly value: number
  get done(): boolean
}
interface TypedDoneGetterCursor {
  next(): TypedDoneGetterStep
  return(): TypedStep
}
interface TypedDoneGetterSource {
  [Symbol.iterator](): TypedDoneGetterCursor
}
let typedDoneGetterState = 'typed-done-getter-open'
const typedDoneGetterSource: TypedDoneGetterSource = {
  [Symbol.iterator]() {
    return {
      next() {
        return {
          value: 1,
          get done(): boolean {
            throw 'typed-done-getter-failure'
          }
        }
      },
      return() {
        typedDoneGetterState = 'typed-done-getter-close'
        return { value: 0, done: true }
      }
    }
  }
}
try {
  for (const value of typedDoneGetterSource) console.log(value)
} catch (error) {
  console.log(`${typedDoneGetterState}:${error}`)
}

interface TypedValueGetterStep {
  get value(): number
  readonly done: boolean
}
interface TypedValueGetterCursor {
  next(): TypedValueGetterStep
  return(): TypedStep
}
interface TypedValueGetterSource {
  [Symbol.iterator](): TypedValueGetterCursor
}
let typedValueGetterState = 'typed-value-getter-open'
const typedValueGetterSource: TypedValueGetterSource = {
  [Symbol.iterator]() {
    return {
      next() {
        return {
          done: false,
          get value(): number {
            throw 'typed-value-getter-failure'
          }
        }
      },
      return() {
        typedValueGetterState = 'typed-value-getter-close'
        return { value: 0, done: true }
      }
    }
  }
}
try {
  for (const value of typedValueGetterSource) console.log(value)
} catch (error) {
  console.log(`${typedValueGetterState}:${error}`)
}
