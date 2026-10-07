// @ts-nocheck
//! expect: unstored a
//! expect: unstored b
//! expect: prefixed 5 a
//! expect: describe a
//! expect: describe b
//! expect: describe a
//! expect: loud a
//! expect: loud b
//! expect: inspector true true

// The renderer hand-off of
// `self-bound-receiver-handed-to-a-field-keeps-map-parameter-native.runtime.js`
// beside binds the value graph must not read as a self-bind: one with a bound
// argument, one whose result is not stored back, and a self-bound slot that
// is later replaced by another object's bound method and by an unbound one.
// Each stays an open use of the renderer, so what the renderer reaches may be
// dynamic; the answers must be right. (A typed Map handed on from such a
// renderer is boxed, and `library.has` on that box aborts by design.)

export {}

class InspectorBase {
  setRenderer(renderer) {
    this._renderer = renderer
  }
}

class Renderer {
  constructor(label) {
    this.label = label
    this.prefixed = this.prefixed.bind(this, 5)
    const unstored = this.unstored.bind(this)
    unstored()
    this.describe = this.describe.bind(this)
    this._inspector = new InspectorBase()
    this._inspector.setRenderer(this)
  }

  prefixed(step) {
    console.log('prefixed', step, this.label)
  }

  unstored() {
    console.log('unstored', this.label)
  }

  describe() {
    console.log('describe', this.label)
  }

  borrow(other) {
    this.describe = other.describe.bind(other)
  }

  loud() {
    console.log('loud', this.label)
  }

  detach() {
    this.describe = this.loud
  }
}

const a = new Renderer('a')
const b = new Renderer('b')
a.prefixed()
a.describe()
b.describe()
b.borrow(a)
b.describe()
a.detach()
a.describe()
a.describe.call(b)
console.log('inspector', a._inspector._renderer === a, b._inspector._renderer === b)
