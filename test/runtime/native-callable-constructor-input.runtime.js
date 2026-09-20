class Owner {
  constructor() {
    this.value = 41
    /** @type {(owner: Owner) => number} */
    this.run = (owner) => owner.value + 1
  }
}

/** @param {Owner} owner */
function ReadOwner(owner) {
  this.value = owner.run(owner)
}

/** @param {Owner} owner */
function ReadOwnerExplicit(owner) {
  this.value = owner.run(owner)
  return this
}

class EmptyBase {}
class DerivedReader extends EmptyBase {
  /** @param {Owner} owner */
  constructor(owner) {
    super()
    this.value = owner.run(owner)
  }
}

const owner = new Owner()
const reader = new ReadOwner(owner)
console.log(reader.value)
console.log(new ReadOwnerExplicit(owner).value)
console.log(new DerivedReader(owner).value)
//! expect: 42
//! expect: 42
//! expect: 42
