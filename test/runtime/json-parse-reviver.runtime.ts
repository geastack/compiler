// `JSON.parse(text, reviver)` -- ECMA-262 25.5.1 InternalizeJSONProperty. The
// reviver sees every property bottom-up (children before their holder, the
// root last under the key ""), an `undefined` answer DELETES the property
// (an array keeps its length and gets a hole), and its `this` is the holder.
// An extended-JSON parser is the shape: a reviver that maps `{ $numberInt: "7" }`
// wrappers to values and passes everything else through, whose result is the
// `any` the program then reads.
const seen: string[] = []
const revived: any = JSON.parse('{"a":1,"b":{"$numberInt":"7"},"c":[1,2,3],"drop":true,"s":"x"}', (key, value) => {
  seen.push(key)
  if (key === 'drop') return undefined
  if (value !== null && typeof value === 'object' && typeof value.$numberInt === 'string') return Number(value.$numberInt) * 10
  if (typeof value === 'number') return value + 1
  return value
})
console.log(seen.join(','))
//! expect: a,$numberInt,b,0,1,2,c,drop,s,
console.log(JSON.stringify(revived))
//! expect: {"a":2,"b":70,"c":[2,3,4],"s":"x"}

const holes: any = JSON.parse('[1,2,3]', (key, value) => (key === '1' ? undefined : value))
console.log(holes.length, 1 in holes, JSON.stringify(holes))
//! expect: 3 false [1,null,3]

const root: any = JSON.parse('"text"', (key, value) => `${key === '' ? 'root' : key}:${value}`)
console.log(root)
//! expect: root:text

function thisIsTheHolder(this: any, key: string, value: any): any {
  return key === 'x' ? this.y : value
}
console.log(JSON.stringify(JSON.parse('{"x":1,"y":5}', thisIsTheHolder)))
//! expect: {"x":5,"y":5}
