//! expect: and-object: 0 3 0 0
//! expect: or-object: 7 3 7 7
//! expect: and-number: 0 0 5 0
//! expect: or-string: left left right empty
//! emitted-lacks: gea::Optional<gea_union_
// A logical operation over operands of different types merges them into a
// wider carrier; `if (a && b)` only asks whether that merge is truthy, so each
// edge branches on its own operand and the merge is never built. Every arm's
// truthiness is checked: a false boolean, an absent object, a zero, NaN, an
// empty string.

interface Point {
  x: number
}

function andObject(engaged: boolean, point: Point | null): number {
  if (engaged && point) return point.x
  return 0
}

function orObject(missing: boolean, point: Point | undefined): number {
  if (missing || !point) return 7
  return point.x
}

function andNumber(flag: boolean, count: number): number {
  if (flag && count) return count
  return 0
}

function orString(label: string, ready: boolean): string {
  if (label || ready) return label === '' ? 'right' : 'left'
  return 'empty'
}

const point: Point = { x: 3 }
console.log('and-object: ' + [andObject(false, point), andObject(true, point), andObject(true, null), andObject(false, null)].join(' '))
console.log(
  'or-object: ' + [orObject(true, point), orObject(false, point), orObject(false, undefined), orObject(true, undefined)].join(' ')
)
console.log('and-number: ' + [andNumber(false, 5), andNumber(true, 0), andNumber(true, 5), andNumber(true, NaN)].join(' '))
console.log('or-string: ' + [orString('a', false), orString('a', true), orString('', true), orString('', false)].join(' '))
