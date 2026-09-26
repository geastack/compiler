// @ts-nocheck
// `Observer` is named in the tag and imported nowhere here, as three's
// `NodeBuilder.js` names `NodeMaterialObserver`.
export class Builder {
  constructor() {
    /**
     * @type {?Observer}
     * @default null
     */
    this.observer = null
  }
}
export class ShaderBuilder extends Builder {
  constructor() {
    super()
    this.stage = 'fragment'
  }
}
