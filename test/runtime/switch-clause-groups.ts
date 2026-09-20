// `case A: case B: body` -- a group of clauses, guarded by ONE disjunction.
//
// An empty clause has no statements to skip, so falling out of its bottom runs
// nothing the language would have run: the group is one arm whose test is
// `A || B`. That is what `producers/control.ts` mints, and it is the commonest
// multi-case idiom there is -- three.js writes it in `getByteLength`,
// `getTextureTypeByteLength`, `getSingularSetter`, `getPureArraySetter` and
// `Color.setStyle`.
//
// What running it proves that reading the emitted C++ does not: EVERY member of
// a group selects the arm, not just the last one; the discriminant is still
// evaluated once; the tests stay strict inside a group; a clause AFTER a group
// is reached only when the whole group failed; and `default` still means every
// group failed.

let evaluations = 0
const discriminant = (n: number): number => {
  evaluations += 1
  return n
}

const size = (n: number): string => {
  switch (discriminant(n)) {
    case 1:
    case 2:
      return 'small'
    case 3:
      return 'medium'
    case 4:
    case 5:
    case 6:
      return 'large'
    default:
      return 'other'
  }
}

//! expect: first-of-group=small
console.log('first-of-group=' + size(1))
//! expect: last-of-group=small
console.log('last-of-group=' + size(2))
//! expect: after-a-group=medium
console.log('after-a-group=' + size(3))
//! expect: group-of-three=large large large
console.log('group-of-three=' + size(4) + ' ' + size(5) + ' ' + size(6))
//! expect: default-after-groups=other
console.log('default-after-groups=' + size(9))
// Six calls above plus this one's arguments: one evaluation each, not one per
// member of the group that was tested.
//! expect: discriminant-evaluations=7
console.log('discriminant-evaluations=' + evaluations)

// `CaseClauseIsSelected` is `IsStrictlyEqual` for every member of a group, not
// only for the one that carries the statements.
const strict = (value: string | number): string => {
  switch (value) {
    case 1:
    case 2:
      return 'number'
    case '1':
    case '2':
      return 'string'
    default:
      return 'neither'
  }
}
//! expect: strict-numbers=number number
console.log('strict-numbers=' + strict(1) + ' ' + strict(2))
//! expect: strict-strings=string string
console.log('strict-strings=' + strict('1') + ' ' + strict('2'))

// A group whose members are NAMES rather than literals -- the shape
// `three/src/extras/TextureUtils.js` writes, where every label is an imported
// constant.
const alpha = 1021
const red = 1028
const rg = 1030
const bytes = (format: number, pixels: number): number => {
  switch (format) {
    case alpha:
      return pixels
    case red:
    case rg:
      return pixels * 2
    default:
      return 0
  }
}
//! expect: named-labels=8 8 4 0
console.log('named-labels=' + bytes(red, 4) + ' ' + bytes(rg, 4) + ' ' + bytes(alpha, 4) + ' ' + bytes(7, 4))

// A group inside a loop, ended by `break`: the break leaves the switch, and the
// statement after it still runs on every iteration.
const trace = (values: readonly number[]): string => {
  let out = ''
  for (const value of values) {
    switch (value) {
      case 0:
      case 1:
        out += 'lo'
        break
      default:
        out += 'hi'
    }
    out += '.'
  }
  return out
}
//! expect: break-leaves-only-the-switch=lo.lo.hi.lo.
console.log('break-leaves-only-the-switch=' + trace([0, 1, 5, 0]))
