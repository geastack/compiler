export class OverlayTexture {
  /** @param {string} kind */
  constructor(kind) {
    this.kind = kind
  }
}

export class OverlayTextureOne extends OverlayTexture {
  constructor() {
    super('one')
  }
}

export class OverlayTextureTwo extends OverlayTexture {
  constructor() {
    super('two')
  }
}

export class OverlayAccessorBase {
  constructor() {
    this._texture = new OverlayTexture('base')
  }

  /** @return {OverlayTexture} */
  get texture() {
    return this._texture
  }

  /** @param {OverlayTexture} value */
  set texture(value) {
    this._texture = value
  }
}

export class OverlayHolderOne extends OverlayAccessorBase {
  constructor() {
    super()
    /** @type {OverlayTextureOne} */
    this.texture = new OverlayTextureOne()
    /** @type {number} */
    this.overlayOnly = 1
  }
}

export class OverlayHolderTwo extends OverlayAccessorBase {
  constructor() {
    super()
    /** @type {OverlayTextureTwo} */
    this.texture = new OverlayTextureTwo()
    /** @type {number} */
    this.overlayOnly = 2
  }
}

export class OverlayFlagBase {}

export class OverlayFlagDerived extends OverlayFlagBase {
  constructor() {
    super()
    this.enabled = false
  }
}

/** @param {OverlayFlagBase} target */
export function enableOverlayFlag(target) {
  target.enabled = true
  return target.enabled
}
