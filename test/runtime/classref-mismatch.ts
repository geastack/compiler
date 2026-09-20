//! expect-abort
// The safety property, which matters more than the happy path: reading a box
// back as the WRONG class must refuse by name rather than reinterpret bytes.
// `unboxClassRef` compares the boxed allocation's authenticated class family,
// so this is expected to ABORT, not to print a plausible number.
class Point {
  x: number
  constructor(x: number) {
    this.x = x
  }
}
class Label {
  text: string
  constructor(text: string) {
    this.text = text
  }
}
const p = new Point(7)
const boxed: unknown = p
const wrong = boxed as Label
console.log(wrong.text)
