class PresenceStorageRoot {}

class PresenceStorageLeft extends PresenceStorageRoot {
  constructor() {
    super()
    /** @type {number} */
    this.leftPayload = 11
  }
}

class PresenceStorageLeaf extends PresenceStorageLeft {}

class PresenceStorageOther {
  constructor() {
    this.marker = 0
  }
}

class PresenceStorageRight extends PresenceStorageRoot {
  constructor() {
    super()
    /** @type {string} */
    this.rightPayload = 'right'
  }
}

/** @param {PresenceStorageRoot} value */
function hasLeft(value) {
  return 'leftPayload' in value
}

/** @param {PresenceStorageRoot | PresenceStorageOther} value */
function hasLeftUnion(value) {
  return 'leftPayload' in value
}

/** @param {PresenceStorageRoot} value */
function removeRight(value) {
  return delete value.rightPayload
}

/** @param {PresenceStorageRoot} value */
function hasRight(value) {
  return 'rightPayload' in value
}

/** @param {PresenceStorageRoot} value @param {string} key @param {number} payload */
function addProperty(value, key, payload) {
  // @ts-expect-error JavaScript permits expanding this object with a runtime key.
  value[key] = payload
}

const root = new PresenceStorageRoot()
const left = new PresenceStorageLeft()
const leaf = new PresenceStorageLeaf()
const right = new PresenceStorageRight()
console.log(hasLeft(root), hasLeft(left), hasLeft(leaf), hasLeft(right))
console.log(hasLeftUnion(left), hasLeftUnion(right), hasLeftUnion(new PresenceStorageOther()))
console.log(hasRight(root), hasRight(left), hasRight(right))
console.log(removeRight(left), removeRight(right), hasRight(right))
addProperty(root, 'rightPayload', 23)
console.log(hasRight(root), removeRight(root), hasRight(root))
console.log(left.leftPayload, leaf.leftPayload)
