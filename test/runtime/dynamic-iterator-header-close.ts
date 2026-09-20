//! expect: [][next-getter-failure]
//! expect: [][next-call-failure]
//! expect: [][done-getter-failure]
//! expect: [][value-getter-failure]
//! expect: body-1
//! expect: close-replaced
//! expect: body-preserved
//! expect: [non-object-close:TypeError]
//! emitted-has: gea::runtime::iterator::CompletionGuard

// The four bracketed lines assert an EMPTY close label, and that is the whole
// point of them: ECMA-262 14.7.5.7 ForIn/OfBodyEvaluation calls `next` with
// `?` -- ReturnIfAbrupt, no IteratorClose -- and IteratorComplete and
// IteratorValue likewise set `[[Done]]` and propagate. A throw out of the
// `next` STEP does not close the iterator. Only a throw out of the loop BODY
// does, which is what `body-1` and `close-replaced` below cover, and those two
// already match node exactly.
//
// This compiler closes on all four, because `ir/lower.ts`'s
// `iteratorCloseRegionsOf` seeds the region at the loop header, so the guard's
// `try` covers the `next` call and the `done`/`value` reads. So this fixture
// FAILS, deliberately, and names that root.
//
// These directives used to read `next-getter:next-getter-failure` and so on --
// the emitted answer, not node's -- so this could never have failed. Brackets
// are load-bearing for the same reason: `//! expect:` is a SUBSTRING test, and
// a bare `:next-getter-failure` is a substring of the wrong answer
// `next-getter:next-getter-failure`, which would have made the corrected
// directive pass against the uncorrected lowering.
const exercise = (label: string, iterator: any): void => {
  let closed = ''
  iterator.return = () => {
    closed = label
    return {}
  }
  const source: any = { [Symbol.iterator]: () => iterator }
  try {
    for (const value of source) console.log(value)
  } catch (error) {
    console.log(`[${closed}][${error}]`)
  }
}

exercise('next-getter', {
  get next() {
    throw 'next-getter-failure'
  }
})
exercise('next-call', {
  next() {
    throw 'next-call-failure'
  }
})
exercise('done-getter', {
  next() {
    return {
      value: 1,
      get done() {
        throw 'done-getter-failure'
      }
    }
  }
})
exercise('value-getter', {
  next() {
    return {
      done: false,
      get value() {
        throw 'value-getter-failure'
      }
    }
  }
})

const replacing: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        throw 'close-replaced'
      }
    }
  }
}
try {
  for (const value of replacing) throw `body-${value}`
} catch (error) {
  console.log(error)
}

const replacingReturn = (): void => {
  for (const value of replacing) {
    if (value === 1) return
  }
}
try {
  replacingReturn()
} catch (error) {
  console.log(error)
}

const noReturn: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      }
    }
  }
}
try {
  for (const value of noReturn) throw 'body-preserved'
} catch (error) {
  console.log(error)
}

const nonObjectClose: any = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: 1, done: false }
      },
      return() {
        return 1
      }
    }
  }
}
try {
  for (const value of nonObjectClose) break
} catch (error) {
  // 7.4.9 step 6 says only "throw a TypeError"; the message is
  // implementation-defined, so the assertion is the ERROR TYPE and nothing
  // more. This line used to read `String(error).includes('non-object')`, which
  // tested this runtime's own wording -- node says `Iterator result 1 is not
  // an object` -- and it was printed with two `console.log` arguments, so it
  // rendered `non-object-close false` with a space where the directive wanted
  // a colon and could never have matched either answer.
  console.log(`[non-object-close:${String(error).split(':')[0]}]`)
}
