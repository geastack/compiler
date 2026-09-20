//! expect: [value 1]
//! dynamic-fallback

// This fixture used to state `//! expect-abort`, on the reasoning that matching
// fields must never authenticate a nominal class, so the cast below had to fail
// closed. That reasoning was right about a lowering the compiler no longer
// emits, and keeping it would now be asserting a divergence from JavaScript
// that nothing justifies.
//
// `(boxed as Expected).value` makes NO nominal claim. The cast is erased -- as
// it is in TypeScript -- and the access lowers to a dynamic property read
// followed by a tag-checked unbox of the RESULT:
//
//   unboxValue<double>(box.getProperty("value"), Tag::Number, ...)
//
// So the program never asserts "this box holds an Expected"; it asserts "the
// value under key `value` is a number", which is true, and which is exactly
// what real node computes -- node prints `1` here. There is no unsound step
// left to fail closed ON. The guard did not go missing: the thing it guarded
// stopped being claimed.
//
// The check that matters is still fail-closed, one level down and at the right
// granularity: had `Forged` carried a non-numeric `value`, or no `value` at
// all, that same unbox would abort rather than reinterpret memory. That is the
// real protection, and it does not depend on the two classes happening to share
// a layout -- which they deliberately do here, so that an unchecked native
// unbox would have printed `1` too and looked identical to a correct answer.

class Expected {
  value = 1
}

class Forged {
  value = 1
}

const boxed: unknown = new Forged()
// Bracketed and labelled: `//! expect:` is a substring test, and a bare `1`
// would be a substring of almost any wrong answer this could produce.
console.log(`[value ${(boxed as Expected).value}]`)
