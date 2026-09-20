class StorageOverlayRoot {
  constructor() {
    this.rootValue = 7
  }
}

class StorageOverlayLeft extends StorageOverlayRoot {
  constructor() {
    super()
    /** @type {number} */
    this.leftPayload = 11
  }
}

class StorageOverlayRight extends StorageOverlayRoot {
  constructor() {
    super()
    /** @type {string} */
    this.rightPayload = 'right'
  }
}

/** @param {StorageOverlayRoot} value @param {string} key */
function readStorage(value, key) {
  // @ts-expect-error JavaScript permits runtime property keys without an index signature.
  return value[key]
}

/** @param {StorageOverlayRoot} value @param {string} key @param {number} payload */
function writeStorage(value, key, payload) {
  // @ts-expect-error JavaScript permits runtime property keys without an index signature.
  value[key] = payload
}

const root = new StorageOverlayRoot()
const left = new StorageOverlayLeft()
const right = new StorageOverlayRight()
console.log(left.leftPayload, right.rightPayload, left.rootValue)
console.log(readStorage(left, 'leftPayload'), readStorage(right, 'rightPayload'))
console.log(readStorage(root, 'leftPayload'), readStorage(left, 'rightPayload'))
writeStorage(left, 'leftPayload', 23)
writeStorage(root, 'leftPayload', 31)
console.log(left.leftPayload, readStorage(root, 'leftPayload'))
console.log(Object.keys(root).join(','), Object.keys(left).join(','), Object.keys(right).join(','))
