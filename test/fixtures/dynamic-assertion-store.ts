// Reading a value back out of the dynamic carrier is a STORE, and it was the
// store direction that had no conversion. A binding initialized from a boxed
// value -- `const back = boxed as T` -- reconciled the cell's carrier against
// the value's by asking only for a WIDENING, on the premise that reads narrow
// and writes widen. That premise is about the direction a cell's declared type
// travels, not the direction a value can: a value out of a box has to be
// NARROWED before the cell can hold it, and that direction answered "no" and
// fell through to the raw operand.
//
// What came out was `double b1; b1 = b0;` and `gea::Ref<Point> b2; b2 = b1;`
// with `b0`/`b1` being `gea::Value` -- an unconverted C++ store. The only
// reason it surfaced at all is that `gea::Value` declares no conversion
// operator, so clang rejects it; a target where C++ *does* carry an implicit
// conversion would have compiled and been silently wrong.
//
// Each case below pins one axis of that failure, because the defect was in the
// store site rather than in any one carrier and every axis reproduced it
// independently.

class Point {
  x: number
  constructor(x: number) {
    this.x = x
  }
}

// A scalar target, at module scope. This is the case that proves the defect was
// never about class instances: `scalarMaterializer` has been installed the whole
// time and this store was still emitted unconverted.
const boxedNumber: unknown = 7
const backNumber = boxedNumber as number

// A string target, the other carrier whose exact-tag read was already installed.
const boxedText: unknown = 'seven'
const backText = boxedText as string

// A class-ref target. This one additionally needs the nominal-token materializer
// to be installed, so it is the case that fails when only the store site is
// fixed -- the two halves are separable and both are required.
const boxedPoint: unknown = new Point(7)
const backPoint = boxedPoint as Point

// The same three inside a function body, because a module-scope cell and a
// local are different placements reaching the same store site, and a fix that
// only reconciled one of them would leave the other emitting a raw assignment.
function readsInsideABody(): number {
  const localBoxedNumber: unknown = 7
  const localBackNumber = localBoxedNumber as number
  const localBoxedPoint: unknown = new Point(7)
  const localBackPoint = localBoxedPoint as Point
  return localBackNumber + localBackPoint.x
}

// Pinned by use rather than merely declared: a binding nothing reads can be
// shaken out, and a store that never happens cannot be checked.
export const total: number = backNumber + backPoint.x + backText.length + readsInsideABody()
