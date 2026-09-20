const dictionary: { [key: string]: string } = { b: 'B', '2': 'two', a: 'A' }
let keys = ''
for (const key in dictionary) {
  keys += key + ':' + dictionary[key] + ';'
  if (key === '2') {
    delete dictionary.b
    dictionary.c = 'C'
  }
}
console.log(keys)
const single: { [key: string]: string } = { one: '1' }
for (const key in single) {
  delete single[key]
  single.two = '2'
  console.log(key)
}
const values: string[] = ['one', 'two']
let joined = ''
for (const value of values) {
  joined += value + ';'
  if (value === 'one') values.push('three')
}
console.log(joined)
const sparse: (string | undefined)[] = ['a', , 'c']
let count = 0
for (const value of sparse) {
  if (value === undefined) count += 10
  else count++
}
console.log(count)
function* sequence(): Generator<string> {
  yield 'first'
  yield 'second'
}
const cursor = sequence()
for (const value of cursor) console.log(value)
for (const value of cursor) console.log(value)
