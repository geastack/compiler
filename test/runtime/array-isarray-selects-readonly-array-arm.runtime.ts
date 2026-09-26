//! expect: a,b, 3 x
// `Array.isArray` over a union holding a readonly array selects that arm,
// though a readonly array is not assignable to the `any[]` the predicate
// spells -- node-compat's `ServerResponse.setHeader`.
type Header = number | string | readonly string[]
function set(value: Header): string {
  if (Array.isArray(value)) {
    const values: readonly string[] = value
    let out = ''
    for (let i = 0; i < values.length; i++) out += String(values[i]) + ','
    return out
  }
  return String(value)
}
console.log(set(['a', 'b']), set(3), set('x'))
