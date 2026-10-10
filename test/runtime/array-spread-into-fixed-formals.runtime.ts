// A final spread of a plain array into a callee with no rest formal
// (a database client's `CancellationToken`: `constructor(...args: any[]) { super(...args) }`
// into `EventEmitter`'s `(options?)`). Each named formal reads `xs[i]`, and
// `undefined` past the array's length is what an omitted argument binds.
class Base {
  label: string
  constructor(options?: { name: string }) {
    this.label = options ? options.name : 'none'
  }
}
class Derived extends Base {
  constructor(...args: any[]) {
    super(...args)
  }
}
console.log(new Derived().label, new Derived({ name: 'n' }).label, new Derived({ name: 'm' }, 7).label)
const pair = (a?: number, b?: number): string => `${a}:${b}`
const xs: number[] = [4]
const ys: number[] = [1, 2, 3]
console.log(pair(...xs), pair(...ys))
//! expect: none n m
//! expect: 4:undefined 1:2
