class Owner {
  constructor() {
    this.value = 40
  }
}

function Slot() {
  /** @type {(owner: Owner) => number} */
  this.run = (owner) => owner.value + 1
}

const slot = new Slot()
const owner = new Owner()
console.log(slot.run(owner))
/** @param {Owner} owner */
function replacement(owner) {
  return owner.value + 2
}
slot.run = replacement
console.log(slot.run(owner))
//! expect: 41
//! expect: 42
