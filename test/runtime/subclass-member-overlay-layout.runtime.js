class LayoutOverlayRoot {}

class LayoutOverlayLeft extends LayoutOverlayRoot {
  constructor() {
    super()
    /** @type {number} */
    this.leftOnly = 1
  }
}

class LayoutOverlayRight extends LayoutOverlayRoot {
  constructor() {
    super()
    /** @type {string} */
    this.rightOnly = 'right'
  }
}

/** @param {LayoutOverlayRoot} value */
const readLeft = (value) => value.leftOnly

/** @param {LayoutOverlayRoot} value */
const readRight = (value) => value.rightOnly

const left = new LayoutOverlayLeft()
const right = new LayoutOverlayRight()

//! expect: subclass-layout=1/right/1/right
console.log(`subclass-layout=${readLeft(left)}/${readRight(right)}/${left.leftOnly}/${right.rightOnly}`)
