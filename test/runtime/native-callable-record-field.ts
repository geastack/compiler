interface Slot {
  run: (owner: Owner) => number
}

class Owner {
  value: number
  slot: Slot

  constructor() {
    this.value = 40
    this.slot = { run: (owner: Owner) => owner.value + 1 }
  }
}

const owner = new Owner()
console.log(owner.slot.run(owner))
let alias: Slot | null = null
alias = owner.slot
alias.run = (owner: Owner) => owner.value + 2
console.log(owner.slot.run(owner))
//! expect: 41
//! expect: 42
