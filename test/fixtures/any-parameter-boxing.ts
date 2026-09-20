// A declared `any` parameter is one of the four boundaries where the boxed
// carrier is CORRECT, and this pins that it stays correct rather than that it
// goes away. `takes` states nothing about its argument, so an object literal
// reaching it has no static shape to lower to and `gea::Value` is the honest
// answer -- the same status as `ToString` of an unknown, a thrown error
// carrier, and `JSON.parse` with no asserted type.
//
// It is here as a MEASUREMENT ANCHOR, not a defect pin. The corpus `boxed`
// column is the compiler's own account of how much it could not type, and a
// column with no fixture holding a known-good value at the bottom of it drifts
// without anyone noticing which direction is which: a change that boxed more
// and a change that boxed less both just move a number. This program's boxes
// are the ones that should survive every such change.
//
// The contrast matters as much as the case: `takesTyped` below is the same
// call with the parameter stated, and it must NOT box. If the two ever report
// the same thing, the boxing is no longer tracking what the program declared.

function takes(value: any): number {
  return 1
}

interface Pair {
  a: number
  b: number
}

function takesTyped(value: Pair): number {
  return value.a + value.b
}

export const boxedCall: number = takes({ a: 1, b: 2 })
export const typedCall: number = takesTyped({ a: 1, b: 2 })
