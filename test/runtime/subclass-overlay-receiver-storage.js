class ReceiverStorageRoot {
  constructor() {
    this.rootPayload = 3
  }
}

class ReceiverStorageBranch extends ReceiverStorageRoot {
  constructor() {
    super()
    writeBranchPayload(this)
  }
}

class ReceiverStorageLeaf extends ReceiverStorageBranch {
  constructor() {
    super()
    this.leafPayload = 5
  }
}

class ReceiverStorageSibling extends ReceiverStorageRoot {
  constructor() {
    super()
    /** @type {string} */
    this.siblingPayload = 'sibling'
  }
}

/** @param {ReceiverStorageBranch} value */
function writeBranchPayload(value) {
  value.siblingPayload = 'branch'
}

/** @param {ReceiverStorageBranch} value */
function readBranchPayload(value) {
  return value.siblingPayload
}

/** @param {ReceiverStorageRoot} value @param {string} key */
function readReceiverKey(value, key) {
  // @ts-expect-error JavaScript permits runtime property keys without an index signature.
  return value[key]
}

const receiverRoot = new ReceiverStorageRoot()
const receiverLeaf = new ReceiverStorageLeaf()
const receiverSibling = new ReceiverStorageSibling()
console.log(readBranchPayload(receiverLeaf), receiverSibling.siblingPayload)
console.log(readReceiverKey(receiverRoot, 'siblingPayload'), readReceiverKey(receiverLeaf, 'siblingPayload'))
console.log(Object.keys(receiverRoot).join(','), Object.keys(receiverLeaf).join(','), Object.keys(receiverSibling).join(','))
