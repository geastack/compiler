// `valueOf()` off a `number | string` -- a binary-document library's `Int32` constructor
// (`if ((value as unknown) instanceof Number) value = value.valueOf()`) and
// its serializer's `value.valueOf()` over a number-or-wrapper union. Each
// primitive arm answers its own `%X%.prototype.valueOf`: the primitive itself.
function unwrap(value: number | string): number | string {
  if ((value as unknown) instanceof Number) {
    value = value.valueOf()
  }
  return value
}
function either(value: number | string): number | string {
  return value.valueOf()
}
console.log(unwrap(7), unwrap('8'), either(9), either('ten'), typeof either(11), typeof either('12'))
//! expect: 7 8 9 ten number string

// A class arm beside the primitive one: `Int32 | number` in the library's
// `serializeInt32`. The class arm calls its own `valueOf`; the number arm
// answers itself.
class Boxed {
  readonly inner: number
  constructor(inner: number) {
    this.inner = inner
  }
  valueOf(): number {
    return this.inner * 2
  }
}
function serializeInt32(value: Boxed | number): number {
  value = value.valueOf()
  return value + 1
}
console.log(serializeInt32(new Boxed(5)), serializeInt32(5))
//! expect: 11 6
