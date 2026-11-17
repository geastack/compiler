function headerText(value: any): string | string[] {
  return Array.isArray(value) ? value.map(String) : String(value)
}

function grow(value: any): number {
  if (!Array.isArray(value)) return -1
  value.push(4)
  value[0] = 10
  return value.length
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : -1
}

const listed = headerText([1, 'two', true])
console.log(Array.isArray(listed), String(listed))
console.log(headerText(42))
const shared: any = [1, 2, 3]
console.log(grow(shared), shared.length, String(shared))
console.log(count(shared), count('x'))
//! expect: true 1,two,true
//! expect: 42
//! expect: 4 4 10,2,3,4
//! expect: 4 -1
export {}
