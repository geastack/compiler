// @ts-nocheck
//! expect: none
//! expect: hit x
//! expect: count 1
// A JS field only a method assigns is absent until that method runs, and the
// checker types it with the `undefined` of that absence: three's
// EventDispatcher `if ( this._listeners === undefined ) this._listeners = {}`.
// Laid out from its one write alone, the field became a non-optional record,
// the test folded to false, and the first listener was stored through a null.
class EventDispatcher {
  addEventListener(type, listener) {
    if (this._listeners === undefined) this._listeners = {}
    const listeners = this._listeners
    if (listeners[type] === undefined) listeners[type] = []
    listeners[type].push(listener)
  }
  dispatchEvent(event) {
    const listeners = this._listeners
    if (listeners === undefined) return false
    const list = listeners[event.type]
    if (list !== undefined) for (let i = 0; i < list.length; i++) list[i].call(this, event)
    return true
  }
}
const d = new EventDispatcher()
if (!d.dispatchEvent({ type: 'x' })) console.log('none')
d.addEventListener('x', (e) => console.log('hit ' + e.type))
d.dispatchEvent({ type: 'x' })
console.log('count ' + d._listeners.x.length)
