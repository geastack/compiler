// three's `EventDispatcher.dispatchEvent`: `event.target = this` on an event
// literal (`{ type: 'dispose' }`) that reaches the dispatcher as a live view of
// the wider event shape. `target` is a key the view names and forwards to its
// source, but the literal's own layout does not declare it, so JavaScript
// creates the property on the literal -- it used to throw "Cannot assign to
// native view property". Listeners read it back through the view, a later
// `event.target = null` overwrites it in place, and enumeration and JSON see
// it in creation order. A plain allocation of the wide shape keeps it in its
// own slot.
interface BaseEvent {
  type: string
}
interface DispatchedEvent extends BaseEvent {
  target?: unknown
}
type Listener = (this: EventDispatcher, event: DispatchedEvent) => void

class EventDispatcher {
  _listeners: { [type: string]: Listener[] } | undefined = undefined
  addEventListener(type: string, listener: Listener): void {
    if (this._listeners === undefined) this._listeners = {}
    const listeners = this._listeners
    if (listeners[type] === undefined) listeners[type] = []
    if (listeners[type]!.indexOf(listener) === -1) listeners[type]!.push(listener)
  }
  dispatchEvent(event: DispatchedEvent): void {
    const listeners = this._listeners
    if (listeners === undefined) return
    const listenerArray = listeners[event.type]
    if (listenerArray !== undefined) {
      event.target = this
      const array = listenerArray.slice(0)
      for (let i = 0, l = array.length; i < l; i++) array[i]!.call(this, event)
      event.target = null
    }
  }
}

class Geometry extends EventDispatcher {
  readonly name: string
  constructor(name: string) {
    super()
    this.name = name
  }
  dispose(): BaseEvent {
    const event: BaseEvent = { type: 'dispose' }
    this.dispatchEvent(event)
    return event
  }
}

const geometry = new Geometry('box')
const seen: string[] = []
geometry.addEventListener('dispose', function (event) {
  seen.push(event.type + ':' + (event.target === geometry) + ':' + (event.target === this) + ':' + Object.keys(event).join(','))
})
geometry.addEventListener('change', function (event) {
  seen.push(event.type + ':' + (event.target === this))
})
const disposed = geometry.dispose()
geometry.dispose()
const change = { type: 'change', message: 'm' }
geometry.dispatchEvent(change)
const plain: DispatchedEvent = { type: 'change', target: 0 }
geometry.dispatchEvent(plain)
geometry.dispatchEvent({ type: 'none' })
console.log(seen.join(' | '))
console.log('after ' + JSON.stringify(disposed) + ' ' + JSON.stringify(change) + ' ' + JSON.stringify(plain))

//! expect: dispose:true:true:type,target | dispose:true:true:type,target | change:true | change:true
//! expect: after {"type":"dispose","target":null} {"type":"change","message":"m","target":null} {"type":"change","target":null}
//! emitted-has: gea::nativeLiveViewForwardedWrite(gea_live_source, gea_key, gea_write)
//! emitted-has: gea::record::writeLiveOpenField<gea::NativeFieldLeafPolicy>(gea_field_receiver, gea::PropertyKey::string("target")
