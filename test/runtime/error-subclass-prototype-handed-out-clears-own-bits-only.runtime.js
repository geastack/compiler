// @ts-nocheck
//! expect: NodeError boom null true
//! expect: proto true false false
// Once any class prototype is handed out at run time (here
// `Object.getPrototypeOf`), every class evaluation builds its prototype
// object and clears the presence bit of each field it does not own. A class
// extending `Error` inherits `name`, `message` and `stack` from the native
// error base, which stores them with no bit beside them, so the clear named
// members the struct does not have. three's `NodeError` (`stackTrace` on top
// of `Error`) is this class.
class NodeError extends Error {
  /** @param {string} message @param {string | null} [stackTrace] */
  constructor(message, stackTrace = null) {
    super(message)
    this.name = 'NodeError'
    this.stackTrace = stackTrace
  }
}
class Plain {
  constructor() {
    this.value = 1
  }
}
const error = new NodeError('boom')
console.log(error.name, error.message, error.stackTrace, error instanceof NodeError)
const proto = Object.getPrototypeOf(new Plain())
console.log('proto', proto === Plain.prototype, Object.hasOwn(proto, 'value'), Object.hasOwn(Object.getPrototypeOf(error), 'stackTrace'))
