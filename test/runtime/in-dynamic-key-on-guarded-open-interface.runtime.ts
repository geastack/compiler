// `unknown` narrowed by a type guard to an interface that declares fixed
// fields and an open `[key: string]: unknown` index, then probed with `key in
// value` for keys the program holds only as runtime strings. Each answer must
// be the object's own: a declared required field is present, an extra wire
// key is present, an absent key is absent, and an inherited member is present.
//! expect: id=true rawMin=true deadband=false
//! expect: id=true rawMin=false deadband=false
//! expect: valid=true
//! expect: valid=false
//! expect: inherited=true
export {}

interface Row {
  id: string
  minimum: number
  [key: string]: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRow(value: unknown): value is Row {
  return isObject(value) && typeof value.id === 'string' && typeof value.minimum === 'number'
}

function describe(value: unknown): string {
  if (!isRow(value)) return 'not a row'
  return ['id', 'rawMin', 'deadband'].map((key) => `${key}=${key in value}`).join(' ')
}

function valid(value: unknown): boolean {
  return isRow(value) && ['rawMin', 'deadband'].every((key) => !(key in value) || typeof value[key] === 'number')
}

const wire: unknown = JSON.parse('{"id":"a","minimum":0,"rawMin":3}')
const bare: unknown = JSON.parse('{"id":"b","minimum":1}')
console.log(describe(wire))
console.log(describe(bare))
console.log(`valid=${valid(wire)}`)
console.log(`valid=${valid(JSON.parse('{"id":"c","minimum":1,"deadband":"x"}'))}`)
const probe = 'toString'
console.log(`inherited=${isRow(wire) && probe in wire}`)
