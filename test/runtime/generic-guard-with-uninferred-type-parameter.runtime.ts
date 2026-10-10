// A generic type guard whose type parameter no argument mentions --
// a library's `isReadonlyArray<T>(value: any): value is readonly T[]`, called
// as `isReadonlyArray(sort)`. `T` falls to `unknown` and the call has one
// copy to run, not a set of copies to dispatch over.
function isReadonlyArray<T>(value: any): value is readonly T[] {
  return Array.isArray(value)
}

const describe = (value: string | readonly string[]): string => {
  if (!isReadonlyArray(value)) return `text ${value}`
  return `list ${value.length}`
}
console.log(describe('a'), describe(['a', 'b']))

//! expect: text a list 2
