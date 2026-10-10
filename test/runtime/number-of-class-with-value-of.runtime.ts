// `Number(x)` over `number | Int32` -- a binary-document library's `Timestamp` constructor
// (`const t = Number(low.t)`). ToNumber of an object is ToPrimitive with hint
// "number" (ECMA-262 7.1.1), so the class's own `valueOf` runs and its
// primitive answer converts; a string answer goes through StringToNumber.
class Int32 {
  readonly value: number
  constructor(value: number) {
    this.value = value
  }
  valueOf(): number {
    return this.value
  }
}
class Decimal {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
  valueOf(): string {
    return this.text
  }
}
function toSeconds(t: number | Int32): number {
  return Number(t)
}
function parsed(value: Decimal | number): number {
  return Number(value) + 1
}
console.log(toSeconds(5), toSeconds(new Int32(42)), parsed(new Decimal('2.5')), parsed(1), Number.isNaN(parsed(new Decimal('x'))))
//! expect: 5 42 3.5 2 true
