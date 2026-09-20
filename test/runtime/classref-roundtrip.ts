//! expect: 7
// The feature under test: a class instance goes INTO the dynamic carrier and
// is read back out as its own class. Before `classRefMaterializer` was
// installed this was refused outright; the question is whether the value that
// comes back is the one that went in.
class Point {
  x: number
  constructor(x: number) {
    this.x = x
  }
}
const p = new Point(7)
const boxed: unknown = p
const back = boxed as Point
console.log(String(back.x))
