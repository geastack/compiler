function identity(value: string): string {
  return value
}

const value = identity('pāss\0word')
console.log(value.length, value.charCodeAt(4), value.slice(5))
console.log('a\0b' === identity('a\0b'), 'a\0b' === identity('a\0c'))
const record = { 'a\0b': 7 }
console.log(Object.keys(record)[0].length, record['a\0b'])
const decoded = JSON.parse('{"a\\u0000b":9}') as { 'a\0b': number }
console.log(decoded['a\0b'])
