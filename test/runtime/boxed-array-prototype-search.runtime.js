// @ts-nocheck
//
// An array reached through an untyped value is a BOXED array: its methods
// come from `dynamicArrayPrototypeGet` (gea_dynamic_proxy.h), not from the
// static array surface. three's `EventDispatcher` keeps its listener arrays in
// an untyped `_listeners` bag, and `hasEventListener`/`addEventListener`/
// `removeEventListener` call `indexOf` on them (and `splice` to remove). Those
// methods were missing from the boxed prototype, so the call read `undefined`
// and the program stopped with "Value is not a function".
//
// The bag is made in the constructor here: three's lazy
// `if (this._listeners === undefined)` is plan item 1.16, a separate defect.
class Dispatcher {
  constructor() {
    this._listeners = {}
  }
  addEventListener(type, listener) {
    const listeners = this._listeners
    if (listeners[type] === undefined) listeners[type] = []
    if (listeners[type].indexOf(listener) === -1) listeners[type].push(listener)
  }
  hasEventListener(type, listener) {
    const listeners = this._listeners
    return listeners[type] !== undefined && listeners[type].indexOf(listener) !== -1
  }
  removeEventListener(type, listener) {
    const listeners = this._listeners
    const listenerArray = listeners[type]
    if (listenerArray !== undefined) {
      const index = listenerArray.indexOf(listener)
      if (index !== -1) listenerArray.splice(index, 1)
    }
  }
  dispatchEvent(event) {
    const listeners = this._listeners
    const listenerArray = listeners[event.type]
    if (listenerArray !== undefined) {
      const array = listenerArray.slice(0)
      for (let i = 0, l = array.length; i < l; i++) array[i].call(this, event)
    }
  }
}

const d = new Dispatcher()
const a = (event) => console.log('a ' + event.type)
const b = (event) => console.log('b ' + event.type)
d.addEventListener('ping', a)
d.addEventListener('ping', b)
d.addEventListener('ping', a)
d.dispatchEvent({ type: 'ping' })
console.log(d.hasEventListener('ping', a), d.hasEventListener('ping', b), d.hasEventListener('pong', a))
d.removeEventListener('ping', a)
console.log(d.hasEventListener('ping', a), d.hasEventListener('ping', b))
d.dispatchEvent({ type: 'ping' })

// The rest of the search/splice family on the same boxed path: an array
// kept in the same untyped bag, read back through a computed key.
const bag = d._listeners
const slot = 'num' + 'bers'
bag[slot] = []
bag[slot].push(1, 2, 3, 2, NaN)
const list = bag[slot]
console.log(list.lastIndexOf(2), list.lastIndexOf(2, -3), list.lastIndexOf(9), list.indexOf(2, 2), list.indexOf(NaN))
console.log(list.includes(NaN), list.includes(3, 3), list.includes(3, -3))
const removed = list.splice(-2, 1, 'x', 'y')
console.log(removed.join(), list.join(), list.length)
console.log(list.splice(1).join(), list.join(), list.length)
//! expect: a ping
//! expect: b ping
//! expect: true true false
//! expect: false true
//! expect: b ping
//! expect: 3 1 -1 3 -1
//! expect: true false true
//! expect: 2 1,2,3,x,y,NaN 6
//! expect: 2,3,x,y,NaN 1 1
