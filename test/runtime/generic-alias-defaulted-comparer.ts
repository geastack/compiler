// A generic FUNCTION-TYPE alias used as a defaulted parameter, in a generic
// helper called at several unrelated type arguments. Each copy of `contains`
// walks `Same<T>` for its own T, and the default `equateValues` is a generic
// callable whose copy is chosen from that same parameter type -- so a second,
// non-equivalent instantiation of the alias is reached while the first is
// still being walked. That is not recursion and must not be refused.
type Same<T> = (a: T, b: T) => boolean

function equateValues<T>(a: T, b: T): boolean {
  return a === b
}

function contains<T>(array: readonly T[], value: T, same: Same<T> = equateValues): boolean {
  for (let index = 0; index < array.length; index += 1) {
    const element = array[index]
    if (element !== undefined && same(element, value)) return true
  }
  return false
}

interface Point {
  x: number
  y: number
}

const samePoint: Same<Point> = (a, b) => a.x === b.x && a.y === b.y

console.log(contains([1, 2, 3], 2), contains([1, 2, 3], 9))
console.log(contains(['a', 'b'], 'b'), contains(['a', 'b'], 'z'))
console.log(contains([{ x: 1, y: 2 }], { x: 1, y: 2 }, samePoint))
