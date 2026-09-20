// `filter` WHOSE PREDICATE IS A TYPE GUARD, SO THE RESULT'S ELEMENT IS
// NARROWER THAN THE RECEIVER'S.
//
// `lib.es5.d.ts` declares `Array.prototype.filter` twice, and the second
// declaration -- `filter<S extends T>(predicate: (value: T) => value is S):
// S[]` -- states that every value the guard kept is an `S`. hono's
// `utils/html.ts` selects it with `res.filter<string>(Boolean as any)` over a
// `(string | undefined)[]`, and the checker publishes the call as `string[]`.
//
// The runtime template answers with the RECEIVER's element, so the store into
// the narrowed cell had no conversion -- and none may be installed, because a
// conversion between two array carriers with different elements can only
// allocate, which detaches a mutable array from every other name for it. The
// narrowing therefore happens inside the call that MINTS the array, where
// nothing else holds it yet.

const present = (value: string | undefined): value is string => value !== undefined

const sparse: (string | undefined)[] = ['a', undefined, 'b', undefined, 'c']

const kept: string[] = sparse.filter(present)

//! expect: kept=a,b,c
console.log('kept=' + kept.join(','))

// The narrowed array is a real `string[]`: its element needs no presence test
// to be used, which is the whole point of the guard overload.
//! expect: upper=A,B,C
console.log('upper=' + kept.map((value: string): string => value.toUpperCase()).join(','))

// A guard that narrows a UNION arm rather than an absence, so the projection
// is an arm selection rather than an unwrap.
class Circle {
  readonly radius: number
  constructor(radius: number) {
    this.radius = radius
  }
}

class Square {
  readonly side: number
  constructor(side: number) {
    this.side = side
  }
}

const isCircle = (shape: Circle | Square): shape is Circle => shape instanceof Circle

const shapes: (Circle | Square)[] = [new Circle(1), new Square(2), new Circle(3)]
const circles: Circle[] = shapes.filter(isCircle)

//! expect: radii=1,3
console.log('radii=' + circles.map((circle: Circle): string => String(circle.radius)).join(','))

// The ordinary (non-guard) declaration still keeps the receiver's element, so
// the plain rendering is unchanged.
//! expect: long=aaa
console.log('long=' + ['a', 'aaa'].filter((value: string): boolean => value.length > 1).join(','))
