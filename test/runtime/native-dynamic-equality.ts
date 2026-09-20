//! expect: true true false false true
//! expect: true false true false
//! expect: true false true false
//! expect: false false

function numberEquals(value: unknown, native: number): boolean {
  return value === native
}
function numberDiffers(native: number, value: unknown): boolean {
  return native !== value
}
function booleanEquals(value: unknown, native: boolean): boolean {
  return value === native
}
function stringEquals(native: string, value: unknown): boolean {
  return native === value
}

console.log(
  numberEquals(JSON.parse('0'), -0),
  numberEquals(JSON.parse('7'), 7),
  numberEquals(JSON.parse('"7"'), 7),
  numberEquals(JSON.parse('true'), 1),
  numberDiffers(7, JSON.parse('null'))
)
console.log(
  booleanEquals(JSON.parse('true'), true),
  booleanEquals(JSON.parse('1'), true),
  booleanEquals(JSON.parse('false'), false),
  booleanEquals(JSON.parse('null'), false)
)
console.log(
  stringEquals('seven', JSON.parse('"seven"')),
  stringEquals('7', JSON.parse('7')),
  stringEquals('', JSON.parse('""')),
  stringEquals('undefined', JSON.parse('null'))
)
console.log(numberEquals(JSON.parse('7'), NaN), numberEquals(JSON.parse('null'), NaN))
