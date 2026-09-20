// @ts-nocheck
//! expect: spread call ok
'use strict'
class Test262Error {
  /** @param {unknown} [message] */
  constructor(message) {
    this.message = String(message ?? 'Test262 assertion failed')
  }
  /** @returns {string} */
  toString() {
    return 'Test262Error: ' + this.message
  }
}

/** @param {unknown} [message] @returns {never} */
function __gea_assert_fail(message) {
  throw new Test262Error(message)
}

/** @returns {void} */
function $DONOTEVALUATE() {
  throw new Test262Error('Test262: This statement should not be evaluated.')
}

const assert = {
  /** @param {unknown} condition @param {unknown} [message] @returns {void} */
  ok(condition, message) {
    if (!condition) __gea_assert_fail(message)
  },
  /** @param {unknown} actual @param {unknown} expected @param {unknown} [message] @returns {void} */
  sameValue(actual, expected, message) {
    if (actual === expected) return
    if (actual !== actual && expected !== expected) return
    __gea_assert_fail(message ?? 'Expected SameValue')
  },
  /** @param {unknown} actual @param {unknown} expected @param {unknown} [message] @returns {void} */
  notSameValue(actual, expected, message) {
    if (actual !== expected) return
    if (actual !== actual && expected !== expected) __gea_assert_fail(message ?? 'Expected different values')
  },
  /** @param {readonly unknown[]} actual @param {readonly unknown[]} expected @param {unknown} [message] @returns {void} */
  compareArray(actual, expected, message) {
    if (actual.length !== expected.length) __gea_assert_fail(message ?? 'Expected arrays to have the same length')
    for (let i = 0; i < actual.length; i++) {
      const a = actual[i]
      const e = expected[i]
      if (a === e) continue
      if (a !== a && e !== e) continue
      __gea_assert_fail(message ?? 'Expected array elements to match')
    }
  },
  /** @param {() => unknown} fn @param {unknown} [message] @returns {void} */
  throws(fn, message) {
    let didThrow = false
    try {
      fn()
    } catch (error) {
      didThrow = true
    }
    if (!didThrow) __gea_assert_fail(message ?? 'Expected function to throw')
  }
}

/** @param {readonly unknown[]} actual @param {readonly unknown[]} expected @param {unknown} [message] @returns {boolean} */
function compareArray(actual, expected, message) {
  assert.compareArray(actual, expected, message)
  return true
}

const $262 = {
  /** @param {unknown} _buffer @returns {void} */
  detachArrayBuffer(_buffer) {
    throw new Test262Error('$262.detachArrayBuffer is not provided by this harness')
  },
  /** @returns {void} */
  gc() {}
}

// A spread as the only argument of an immediately-invoked function expression,
// read back through `arguments` -- test262's
// `language/expressions/call/spread-{sngl,mult}-*` shape, carried with the
// same harness prelude those cases are compiled with. The prelude is the point:
// the crash this pins needed BOTH the spread call and the harness's own
// `assert` object in one program.
var callCount = 0

;(function () {
  assert.sameValue(arguments.length, 3)
  assert.sameValue(arguments[0], 3)
  assert.sameValue(arguments[1], 4)
  assert.sameValue(arguments[2], 5)
  callCount += 1
})(...[3, 4, 5])

assert.sameValue(callCount, 1)
console.log('spread call ok')
