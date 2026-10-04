// @ts-nocheck
class EventDispatcher {
  /**
   * @param {string} type
   */
  addEventListener(type) {
    this._type = type
  }
}

export { EventDispatcher }
