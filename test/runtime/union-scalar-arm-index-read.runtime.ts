// A canonical index read through a union whose other arm is a number. A binary-document
// deserializer keys array elements by number and object members by string,
// and tests `(name as string)[0] === '$'` on a key it knows is a string there;
// JavaScript answers `undefined` for `(5)[0]`, and the string-typed read spells
// that absence as a string index out of range does.
function startsWithDollar(name: string | number): boolean {
  return (name as string)[0] === '$'
}
const keys: (string | number)[] = ['$ref', 'x', 0, 12, '']
console.log(keys.map(startsWithDollar).join(','))
//! expect: true,false,false,false,false
