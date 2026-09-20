// A `try` region reached from somewhere other than the block just before it.
//
// C++ forbids transferring control INTO a try block, so this rendering used to
// require the predecessor to fall straight through into the region's braces --
// and refused whenever the block order put anything between the two. A label
// on the try STATEMENT is not inside the block, so an ordinary `goto` reaches
// it and the region renders wherever the order puts it.
//
// What running it proves that reading the emitted C++ does not: the jump lands
// on the try and not on whatever block was emitted in between; the handler
// still catches what the body throws; a try inside a loop is re-entered on
// every iteration; and the value a branch computed before the jump survives
// into the region.

const classify = (n: number): string => {
  let note = ''
  if (n < 0) {
    note = 'neg'
  } else {
    note = 'pos'
    if (n > 100) {
      return note + ':skipped'
    }
  }
  try {
    if (n === 0) {
      throw new Error('zero')
    }
    return note + ':ok'
  } catch (error) {
    return note + ':caught'
  }
}

//! expect: negative=neg:ok
console.log('negative=' + classify(-3))
//! expect: positive=pos:ok
console.log('positive=' + classify(3))
//! expect: zero=pos:caught
console.log('zero=' + classify(0))
//! expect: skipped=pos:skipped
console.log('skipped=' + classify(500))

// The same region entered once per iteration, with a handler that runs on some
// of them and not others.
const sum = (values: readonly number[]): string => {
  let total = 0
  let caught = 0
  for (const value of values) {
    try {
      if (value < 0) {
        throw new Error('negative')
      }
      total += value
    } catch (error) {
      caught += 1
    }
  }
  return total + '/' + caught
}

//! expect: loop=6/2
console.log('loop=' + sum([1, -1, 2, -2, 3]))
