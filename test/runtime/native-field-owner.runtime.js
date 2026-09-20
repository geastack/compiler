class OwnerRoot {
  constructor() {
    this.rootValue = 3
  }
}

class OwnerLeft extends OwnerRoot {
  constructor() {
    super()
    this.leftOnly = 11
  }
}

class OwnerRight extends OwnerRoot {
  constructor() {
    super()
    this.rightOnly = 'right'
  }
}

class OwnerLeaf extends OwnerLeft {}

/** @param {OwnerRoot} value */
function readLeftOwner(value) {
  return value.leftOnly
}

/** @param {OwnerRoot} value */
function readRightOwner(value) {
  return value.rightOnly
}

const ownerRoot = new OwnerRoot()
const ownerLeft = new OwnerLeft()
const ownerRight = new OwnerRight()
const ownerLeaf = new OwnerLeaf()

//! expect: left=undefined/11/undefined/11
console.log(`left=${readLeftOwner(ownerRoot)}/${readLeftOwner(ownerLeft)}/${readLeftOwner(ownerRight)}/${readLeftOwner(ownerLeaf)}`)
//! expect: right=undefined/undefined/right/undefined
console.log(`right=${readRightOwner(ownerRoot)}/${readRightOwner(ownerLeft)}/${readRightOwner(ownerRight)}/${readRightOwner(ownerLeaf)}`)
ownerLeft.leftOnly = 27
//! expect: updated=27/11
console.log(`updated=${readLeftOwner(ownerLeft)}/${readLeftOwner(ownerLeaf)}`)
//! expect: keys=rootValue,leftOnly/rootValue,rightOnly
console.log(`keys=${Object.keys(ownerLeft).join(',')}/${Object.keys(ownerRight).join(',')}`)
