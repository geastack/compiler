//! expect: NaN|0|1|16|Infinity|NaN|23|41
//! dynamic-fallback
//! emitted-has: gea::dynamicToNumber(

function mark(value: number): string {
  if (value !== value) return 'NaN'
  if (value === Infinity) return 'Infinity'
  return String(value)
}

const undefinedValue: any = undefined
const nullValue: any = null
const booleanValue: any = true
const hexadecimalValue: any = '\u00a0 0x10 \ufeff'
const infinityValue: any = 'Infinity'
const invalidValue: any = '12no'

const ordinary: any = {}
ordinary.valueOf = function () {
  return 23
}
ordinary.toString = function () {
  return 99
}

const exotic: any = {}
exotic[Symbol.toPrimitive] = function (hint: string) {
  return hint === 'number' ? 41 : 0
}

console.log(
  mark(Number(undefinedValue)) +
    '|' +
    mark(Number(nullValue)) +
    '|' +
    mark(Number(booleanValue)) +
    '|' +
    mark(Number(hexadecimalValue)) +
    '|' +
    mark(Number(infinityValue)) +
    '|' +
    mark(Number(invalidValue)) +
    '|' +
    mark(Number(ordinary)) +
    '|' +
    mark(Number(exotic))
)
