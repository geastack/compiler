class Owner {
  value: number
  run: (owner: Owner) => number
  constructor() {
    this.value = 40
    this.run = (owner: Owner) => owner.value + 1
  }
}

const owners: Owner[] = [new Owner()]
const copy = [...owners]
const owner = copy[0]!
console.log(Object.keys(owner).length)
console.log('run' in owner)
console.log(owner.run(owner))

const callbacks: ((owner: Owner) => number)[] = [(owner: Owner) => owner.value + 2]
const before = callbacks[0]!
console.log(before(owner))
callbacks[0] = (owner: Owner) => owner.value + 3
const after = callbacks[0]!
console.log(after(owner))
//! expect: 2
//! expect: true
//! expect: 41
//! expect: 42
//! expect: 43
