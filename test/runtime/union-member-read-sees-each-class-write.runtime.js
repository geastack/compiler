//! expect: shown:null|3|r|null
// A field read through a `Left | Right` receiver names the checker's
// synthesized union member, while each class's own `this.slot = ...` writes
// name that class's member. The read may see any of them, so its cell joins
// every write into either class's `slot`.
class Left {
  constructor() {
    this.slot = null
  }
  fill(value) {
    this.slot = value
    return this
  }
}
class Right {
  constructor() {
    this.slot = null
  }
  fill(value) {
    this.slot = value
    return this
  }
}
/** @param {Left | Right} side */
const show = (side) => String(side.slot)
console.log('shown:' + [show(new Left()), show(new Left().fill(3)), show(new Right().fill('r')), show(new Right())].join('|'))
export {}
