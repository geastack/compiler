//! expect: 3
//! expect: 5
// hono's node-server websocket bridge normalizes one-or-many with the
// identifier form of the `Array.isArray` idiom:
//
//   const datas = Array.isArray(data) ? data : [data]
//   for (const data of datas) { ... }
//
// `normalizedArrayConditionalType` already recognised the ELEMENT-ACCESS form
// (`Array.isArray(values[i]) ? values[i] : [values[i]]`) and nothing else, so
// the identifier form joined both arms and republished the whole
// scalar-or-array union -- and the `for ... of` that follows then read an
// element off a carrier whose scalar arms are not indexable.
interface Chunk {
  size: number
}
type Data = string | Chunk

const sizeOf = (data: Data | Data[]): number => {
  const datas = Array.isArray(data) ? data : [data]
  let total = 0
  for (const one of datas) total += typeof one === 'string' ? one.length : one.size
  return total
}

console.log(sizeOf('abc'))
console.log(sizeOf([{ size: 2 }, 'cde']))
