//! expect-refusal: without monomorphization
// node prints plain:8, counter:20, shown:N1|Slabel|N6 and raw:10|label.
// A field of a `@template` class read through an instantiation
// (`Box<number>`) names the checker's instantiated copy of `Box.value`, while
// the write through `this` inside the class and each subclass constructor's
// own assignment name other symbols. Where the checker types the read
// (`Box<number>`) the field census is never asked; where it leaves it `any`
// (`Box<any>`) the census refuses the instantiated copy
// (`transient-member-symbol-generic`) rather than join only the writes filed
// under it. Today the whole program still refuses earlier, at the class's
// type parameter; once that monomorphizes, every read here must see every
// write and print what node prints.
/** @template T */
class Box {
  /** @param {T} value */
  constructor(value) {
    this.value = value
  }
  /** @param {T} next */
  put(next) {
    this.value = next
  }
}
/** @extends {Box<number>} */
class Counter extends Box {
  constructor() {
    super(1)
    this.value = 10
  }
}
/** @extends {Box<number|string>} */
class Labeled extends Box {
  constructor() {
    super(1)
    this.value = 'label'
  }
}
/** @param {Box<number>} box */
const twice = (box) => box.value * 2
/** @param {Box<number|string>} box */
const show = (box) => (typeof box.value === 'string' ? 'S' + box.value : 'N' + box.value)
/** @param {Box<any>} box */
const raw = (box) => String(box.value)
const plain = new Box(3)
plain.put(4)
console.log('plain:' + twice(plain))
console.log('counter:' + twice(new Counter()))
/** @type {Box<number|string>} */
const mixed = new Box(6)
console.log('shown:' + [show(new Box(1)), show(new Labeled()), show(mixed)].join('|'))
console.log('raw:' + [raw(new Counter()), raw(new Labeled())].join('|'))
export {}
