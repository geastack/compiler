const suffix = '!'
const replacer = function (this: any, key: string, value: any): any {
  if (key === '') return { message: value + suffix, nested: { count: 1 } }
  if (key === 'count') return 2
  return value
}

console.log(JSON.stringify('hello', replacer, 2))
console.log(JSON.stringify('hello', ['message'], 2))

const dynamicRoot: any = { message: 'hello', nested: { count: 1 } }
const dynamicReplacer = function (key: string, value: any): any {
  if (key === 'count') return 2
  return value
}
console.log(JSON.stringify(dynamicRoot, dynamicReplacer, 2))
