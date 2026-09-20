//! expect: count=0
//! expect: n=1 s=x b=true
//! expect: count=3
//! expect: pair=1:x
//! expect: doubled=2 upper=X
//! expect: same=true
// A generic class instantiated at THREE layouts -- `Box<number>`,
// `Box<string>` and, through the static factory's own type parameter,
// `Box<boolean>` -- is three physical classes with one shared static side:
// JavaScript has one `Box` object, so `Box.count` is one cell every
// constructor increments and `Box.create<U>` is one function whose copies
// construct whichever layout `U` names. Instances of each layout are passed
// to functions typed with that instantiation, have their methods called from
// outside the class, and are read through `instanceof`, all of which resolve
// through the instantiation's own physical class rather than the root.
class Box<T> {
  static count = 0
  static create<U>(value: U): Box<U> {
    return new Box<U>(value)
  }
  value: T
  constructor(value: T) {
    this.value = value
    Box.count += 1
  }
  get(): T {
    return this.value
  }
  map<R>(transform: (value: T) => R): Box<R> {
    return new Box<R>(transform(this.value))
  }
}

console.log('count=' + Box.count)
const n = new Box<number>(1)
const s = new Box<string>('x')
const b = Box.create<boolean>(true)
console.log('n=' + n.get() + ' s=' + s.get() + ' b=' + b.get())
console.log('count=' + Box.count)

const pair = (left: Box<number>, right: Box<string>): string => left.get() + ':' + right.value
console.log('pair=' + pair(n, s))

const doubled = n.map((value) => value * 2)
const upper = s.map((value) => value.toUpperCase())
console.log('doubled=' + doubled.get() + ' upper=' + upper.get())
console.log('same=' + (n instanceof Box && s instanceof Box && b instanceof Box))
