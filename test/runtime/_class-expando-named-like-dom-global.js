// A module class whose name lib.dom also declares as a global value, with a
// static assigned onto it from module scope: three's `nodes/core/Node.js`
// (`Node.captureStackTrace = false`). Imported by
// `class-expando-named-like-dom-global.runtime.js`.
class Node {
  constructor(kind) {
    this.kind = kind
    this.traced = false
    if (Node.captureStackTrace === true) this.traced = true
  }
}

Node.captureStackTrace = false

export default Node
