// A pattern-named parameter: the argument occupies one frame slot and the
// pattern's elements read it from there. An object pattern's element is a
// property read, so it needs no destructuring primitive of its own.

interface Point {
  x: number
  y: number
}

export function distanceSquared({ x, y }: Point): number {
  return x * x + y * y
}

export const measured = distanceSquared({ x: 3, y: 4 })
