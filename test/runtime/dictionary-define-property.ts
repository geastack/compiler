const table: Record<string, string> = {}
const key: string = '__proto__'

Object.defineProperty(table, key, {
  value: 'stored-as-data',
  writable: true,
  enumerable: true,
  configurable: true
})

console.log(Object.keys(table).join(','))
console.log(table[key])
