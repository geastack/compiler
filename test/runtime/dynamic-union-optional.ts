//! expect: absent|16|null|boolean:true|string:text|number:7
//! dynamic-fallback
//! emitted-has: dynamic value admitted by no union arm

function optional(value?: number): string {
  return value === undefined ? 'absent' : String(value)
}

function nullable(value: number | null): string {
  return value === null ? 'null' : String(value)
}

function primitive(value: boolean | string | number): string {
  return typeof value + ':' + String(value)
}

const absent: any = undefined
const numeric: any = 16
const nullValue: any = null
const truth: any = true
const text: any = 'text'
const number: any = 7

console.log(
  optional(absent) +
    '|' +
    optional(numeric) +
    '|' +
    nullable(nullValue) +
    '|' +
    primitive(truth) +
    '|' +
    primitive(text) +
    '|' +
    primitive(number)
)
