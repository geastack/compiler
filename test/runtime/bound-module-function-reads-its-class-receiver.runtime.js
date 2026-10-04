// @ts-nocheck
//! expect: ended 1 true 0
//! expect: event select 1
//! expect: keys 1
// three's XRManager keeps its session handlers as module functions bound in
// the constructor (`this._onSessionEnd = onSessionEnd.bind( this )`).
// `onSessionEnd` writes `this._session = null`, so the checker infers it as a
// constructor and its `this` as its own layout, where `this._session` reads
// `undefined`. Every reference binds it on a Manager, so its receiver is
// the Manager and `_session` is the field's `?Session`.
class Session {
  constructor() {
    this.listeners = 0
  }
  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) {
    this.listeners++
  }
  /** @param {string} type @param {Function} fn */
  removeEventListener(type, fn) {
    this.listeners--
  }
}
class Manager {
  constructor() {
    /** @type {Function} */
    this._onSessionEnd = onSessionEnd.bind(this)
    /** @type {Function} */
    this._onSessionEvent = onSessionEvent.bind(this)
    /**
     * @type {?Session}
     * @default null
     */
    this._session = null
    this.ended = 0
    this.events = 0
  }
  /** @param {Session} session */
  setSession(session) {
    this._session = session
    session.addEventListener('end', this._onSessionEnd)
  }
  getSession() {
    return this._session
  }
}
function onSessionEvent(event) {
  this.events++
  return event.type + ' ' + this.events
}
function onSessionEnd() {
  const session = this._session
  session.removeEventListener('end', this._onSessionEnd)
  this.ended++
  this._session = null
}
const box = JSON.parse('{}')
box[String(Math.random())] = 1
const manager = new Manager()
const session = new Session()
manager.setSession(session)
manager._onSessionEnd()
console.log('ended', manager.ended, manager.getSession() === null, session.listeners)
console.log('event', manager._onSessionEvent({ type: 'select' }))
console.log('keys', Object.keys(box).length)
