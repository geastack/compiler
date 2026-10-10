// A plain object inside `any` -- a `JSON.parse` result here, a deserialized
// document in a database client -- received where the program declares an Array of
// typed records. Each element is read into the record through a checked
// conversion: present keys are converted per field, an absent optional field
// stays absent, and a missing required field or a mistyped value is a
// TypeError at the boundary instead of an abort.
//
// node never checks the declared type, so the refusing rows are written to
// throw a TypeError there as well, one step later, at the first use of the
// field the conversion refused.
interface Row {
  a: number
  b?: string
}

function total(rows: Array<Row>): string {
  let sum = 0
  const names: string[] = []
  for (const row of rows) {
    sum += row.a
    names.push(row.b === undefined ? '-' : row.b)
  }
  return `${rows.length} ${sum} ${names.join(',') || 'none'}`
}

function receive(value: any): string {
  return total(value)
}

function upper(value: any): string {
  try {
    const rows: Array<Row> = value
    return rows.map((row) => `${row.a.toFixed(1)}:${row.b === undefined ? '-' : row.b.toUpperCase()}`).join(' ')
  } catch (error) {
    return error instanceof TypeError ? 'TypeError' : 'other'
  }
}

console.log(receive(JSON.parse('[{"a":1,"b":"x"},{"a":2},{"a":3.5,"b":"z","extra":true}]')))
console.log(receive(JSON.parse('[]')))
console.log(upper(JSON.parse('[{"a":1,"b":"q"},{"a":2}]')))
// Missing required `a`.
console.log(upper(JSON.parse('[{"b":"q"}]')))
// `b` is present but not a string.
console.log(upper(JSON.parse('[{"a":1,"b":7}]')))
// The record IS the parsed object: a write through the typed name is a read
// through the `any` one, and the other way round.
function identity(value: any): string {
  const rows: Array<Row> = value
  rows[0]!.a = 9
  value[0].b = 'w'
  return `${value[0].a} ${rows[0]!.b} ${Object.keys(value[0]).sort().join(',')} order=${Object.keys(value[0]).join(',')}`
}
console.log(identity(JSON.parse('[{"a":1,"extra":true}]')))

// A database client's shape: an interface over an open Document, with a nested record.
interface Doc {
  [key: string]: any
}
interface Info extends Doc {
  name: string
  meta?: { size: number }
}
function infos(value: any): string {
  const all: Info[] = value
  return all.map((info) => `${info.name}:${info.meta === undefined ? '-' : info.meta.size}:${info['kind']}`).join(' ')
}
console.log(infos(JSON.parse('[{"name":"a","meta":{"size":3},"kind":"c"},{"name":"b"}]')))
//! expect: 3 6.5 x,-,z
//! expect: 0 0 none
//! expect: 1.0:Q 2.0:-
//! expect: TypeError
//! expect: TypeError
//! expect: 9 w a,b,extra order=a,extra,b
//! expect: a:3:c b:-:undefined
