// `switch` -- lowered as the `if`/`else if` chain it is.
//
// One discriminant, evaluated ONCE, then a chain of strict-equality tests:
// clause `i` runs when its own test held and every earlier one did not. That is
// exactly `switch` for every shape that does not fall through, and the shapes
// that do are refused by name rather than compiled into a chain that silently
// skips the statements the language would run.
//
// What running it proves that reading the emitted C++ does not: the
// discriminant is evaluated once and not once per case; the tests are STRICT,
// so `'1'` does not select `case 1`; a `break` leaves only the switch and not
// an enclosing loop; and a `default` written last is reached only when every
// case failed.

let evaluations = 0
const discriminant = (n: number): number => {
  evaluations += 1
  return n
}

const classify = (n: number): string => {
  let label = ''
  switch (discriminant(n)) {
    case 0:
      label = 'zero'
      break
    case 1:
      label = 'one'
      break
    default:
      label = 'many'
  }
  return label
}

//! expect: first-case=zero
console.log('first-case=' + classify(0))
//! expect: later-case=one
console.log('later-case=' + classify(1))
//! expect: default=many
console.log('default=' + classify(7))
// Three calls, three evaluations -- not one per case tested.
//! expect: discriminant-evaluations=3
console.log('discriminant-evaluations=' + evaluations)

// `CaseClauseIsSelected` is `IsStrictlyEqual`, so no coercion happens.
const strict = (value: string | number): string => {
  switch (value) {
    case 1:
      return 'number-one'
    case '1':
      return 'string-one'
    default:
      return 'neither'
  }
}
//! expect: strict-number=number-one
console.log('strict-number=' + strict(1))
//! expect: strict-string=string-one
console.log('strict-string=' + strict('1'))

// `return` ends a clause as well as `break` does, and leaves the function.
const sign = (n: number): string => {
  switch (n < 0 ? -1 : n > 0 ? 1 : 0) {
    case -1:
      return 'negative'
    case 1:
      return 'positive'
    default:
      return 'zero'
  }
}
//! expect: returns=negative positive zero
console.log('returns=' + sign(-5) + ' ' + sign(5) + ' ' + sign(0))

// A `break` inside a loop's body names the SWITCH, not the loop: the statement
// after the switch still runs, and the loop still iterates.
const trace = (values: readonly number[]): string => {
  let out = ''
  for (const value of values) {
    switch (value) {
      case 0:
        out += 'z'
        break
      default:
        out += 'n'
    }
    out += '.'
  }
  return out
}
//! expect: break-leaves-only-the-switch=z.n.z.
console.log('break-leaves-only-the-switch=' + trace([0, 3, 0]))
