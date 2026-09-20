import { Base } from './base.js'
import { MultiplyOperation } from './constants.js'

export class Child extends Base {
  constructor() {
    super()
    /** @type {(MultiplyOperation|MixOperation|AddOperation)} */
    this.combine = MultiplyOperation
  }
}

/** @param {Base} material */
export function read(material) {
  return material.combine
}
