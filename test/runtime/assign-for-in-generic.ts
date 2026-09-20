function hasProperty(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key)
}
function assign<T extends object>(t: T, ...args: (T | undefined)[]): T {
  for (const arg of args) {
    if (arg === undefined) continue
    for (const p in arg) {
      if (hasProperty(arg, p)) t[p] = arg[p]
    }
  }
  return t
}
interface Opts {
  a: number
  b: string
}
const r = assign<Opts>({ a: 1, b: 'x' }, undefined, { a: 2, b: 'y' })
console.log(r.a, r.b)
//! expect: 2 y
