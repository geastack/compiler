// @ts-nocheck
//! expect: childadded a
//! expect: childadded b
//! expect: cleared 2
// An event record allocated with a `null` field that the program later
// stores an object into: three's `const _childaddedEvent = { type:
// 'childadded', child: null }` (tagged only `@type {Object}`) is written
// `_childaddedEvent.child = object` in `Object3D.add` and reset to `null`
// after the dispatch. The field holds what the program stores in it -- the
// written class or null -- not the `null` its allocation spelled.
class EventDispatcher {
  constructor() {
    this._listeners = {}
  }
  addEventListener(type, listener) {
    const listeners = this._listeners
    if (listeners[type] === undefined) listeners[type] = []
    listeners[type].push(listener)
  }
  /** @param {Object} event - The event that gets fired. */
  dispatchEvent(event) {
    const listeners = this._listeners
    const listenerArray = listeners[event.type]
    if (listenerArray !== undefined) {
      event.target = this
      const array = listenerArray.slice(0)
      for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event)
      event.target = null
    }
  }
}

/**
 * @event Object3D#childadded
 * @type {Object}
 */
const _childaddedEvent = { type: 'childadded', child: null }

class Object3D extends EventDispatcher {
  constructor(name) {
    super()
    this.name = name
    this.children = []
    /** @type {?Object3D} */
    this.parent = null
  }
  /**
   * @param {Object3D} object
   * @return {Object3D}
   */
  add(object) {
    object.parent = this
    this.children.push(object)
    _childaddedEvent.child = object
    this.dispatchEvent(_childaddedEvent)
    _childaddedEvent.child = null
    return this
  }
}

const root = new Object3D('root')
root.addEventListener('childadded', (event) => console.log(event.type + ' ' + (event.child === null ? 'none' : event.child.name)))
root.add(new Object3D('a')).add(new Object3D('b'))
console.log((_childaddedEvent.child === null ? 'cleared' : 'kept') + ' ' + root.children.length)
