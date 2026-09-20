//! expect: 7
// Control: exercises the same shim with no boxed class anywhere. A crash here
// would mean the harness is broken, not the feature under test.
class Point {
  x: number
  constructor(x: number) {
    this.x = x
  }
}
const p = new Point(7)
console.log(String(p.x))
