//! expect: true false true true false
//! expect: true false true false
//! expect: true false true false
//! expect: false true false true
//! expect: true 12
//! expect: false 21

function sameNumber(value: unknown, native: number): boolean {
  return value === native
}
function differentNumber(native: number, value: unknown): boolean {
  return native !== value
}
function sameBoolean(value: unknown, native: boolean): boolean {
  return value === native
}
function sameString(native: string, value: unknown): boolean {
  return native === value
}
function sameBigInt(value: unknown, native: bigint): boolean {
  return value === native
}
function differentBigInt(native: bigint, value: unknown): boolean {
  return native !== value
}
function sameSymbol(value: unknown, native: symbol): boolean {
  return value === native
}
function differentSymbol(native: symbol, value: unknown): boolean {
  return native !== value
}

console.log(
  sameNumber(JSON.parse('7'), 7),
  sameNumber(JSON.parse('"7"'), 7),
  sameNumber(JSON.parse('0'), -0),
  differentNumber(7, JSON.parse('null')),
  sameNumber(JSON.parse('7'), NaN)
)
console.log(
  sameBoolean(JSON.parse('true'), true),
  sameBoolean(JSON.parse('1'), true),
  sameBoolean(JSON.parse('false'), false),
  sameBoolean(JSON.parse('null'), false)
)
console.log(
  sameString('seven', JSON.parse('"seven"')),
  sameString('7', JSON.parse('7')),
  sameString('', JSON.parse('""')),
  sameString('undefined', JSON.parse('null'))
)
const key = Symbol('key')
console.log(
  sameBigInt(JSON.parse('7'), 7n),
  differentBigInt(7n, JSON.parse('7')),
  sameSymbol(JSON.parse('null'), key),
  differentSymbol(key, JSON.parse('null'))
)

let order = 0
function dynamicNumber(): unknown {
  order = order * 10 + 1
  return JSON.parse('7')
}
function nativeNumber(): number {
  order = order * 10 + 2
  return 7
}
console.log(dynamicNumber() === nativeNumber(), order)
order = 0
console.log(nativeNumber() !== dynamicNumber(), order)
