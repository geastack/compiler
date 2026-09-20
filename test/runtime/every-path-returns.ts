// Functions in which every path already returned before the statement's own
// marker operation is reached.
//
// `if`, `switch` and `debugger` lower to nothing: the transfers they stand for
// are built by the flow controller out of scope membership. But the census
// ordinals a statement post-order -- after everything inside it -- so the
// marker for an `if` whose two arms both `return` is scheduled once every path
// has already terminated. Given a scope to enter, it got a fresh block, the
// body then looked like one that runs off its end, and the synthesized
// terminator was a valueless `return` in a function with a return type.
//
// clang rejects that outright ("non-void function should return a value"), so
// this is not a wrong answer at runtime -- it is a program that does not build.
// `if (n === 1) return 'one'; else return 'other'` is as ordinary as TypeScript
// gets, and no corpus program happened to be shaped like it, which is why this
// file exists rather than a fixture.

const pick = (n: number): string => {
  if (n === 1) {
    return 'one'
  } else {
    return 'other'
  }
}
//! expect: if-else=one other
console.log('if-else=' + pick(1) + ' ' + pick(2))

const grade = (score: number): string => {
  if (score > 90) {
    return 'a'
  } else if (score > 80) {
    return 'b'
  } else {
    return 'c'
  }
}
//! expect: chain=a b c
console.log('chain=' + grade(95) + ' ' + grade(85) + ' ' + grade(10))

// The same shape one level in: the inner `if` terminates both of the outer
// one's arms, so the outer marker is reached with nothing live either.
const quadrant = (x: number, y: number): string => {
  if (x >= 0) {
    if (y >= 0) {
      return 'ne'
    } else {
      return 'se'
    }
  } else {
    if (y >= 0) {
      return 'nw'
    } else {
      return 'sw'
    }
  }
}
//! expect: nested=ne se nw sw
console.log('nested=' + quadrant(1, 1) + ' ' + quadrant(1, -1) + ' ' + quadrant(-1, 1) + ' ' + quadrant(-1, -1))

// A loop whose body returns on the first iteration, with a return after it:
// the loop's own marker is reached from the path that never entered the body.
const firstEven = (values: readonly number[]): number => {
  for (const value of values) {
    if (value % 2 === 0) {
      return value
    }
  }
  return -1
}
//! expect: loop=4 -1
console.log('loop=' + firstEven([1, 3, 4, 5]) + ' ' + firstEven([1, 3, 5]))

// A `void` function whose paths all return is the control: the synthesized
// terminator IS legal there, and must stay.
let sink = ''
const record = (flag: boolean): void => {
  if (flag) {
    sink += 'y'
    return
  }
  sink += 'n'
}
record(true)
record(false)
//! expect: void-fn=yn
console.log('void-fn=' + sink)
