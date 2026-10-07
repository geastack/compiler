// @ts-nocheck
//! expect: has x true
//! expect: has y false
//! expect: callback 2 true
//! expect: inspector true
//! emitted-has: ->has(
//! emitted-lacks: literalPropertyGet<"has">

// three's Renderer self-binds a listener and then hands itself to its
// inspector: `this._inspector.setRenderer( this )`. The value graph followed
// the bind call as a call it could not resolve, so the renderer's closure
// opened, the inspector field had no proven value, and the census refused
// every parameter reached from the renderer -- `NodeLibrary.addType` got its
// Map boxed and `library.has` was a read on that box. The proven self-bind is
// a bound function in the graph now: it runs the method with the renderer as
// `this`, and it is followed into the slot it is stored in.

export {}

class NodeLibrary {
  constructor() {
    this.someMap = new Map([['x', 1]])
    this.add(1, 'x')
    this.add(2, 'y')
  }

  add(x, type) {
    this.addType(x, type, this.someMap)
  }

  addType(x, type, library) {
    console.log('has', type, library.has(type))
  }
}

class InspectorBase {
  setRenderer(renderer) {
    this._renderer = renderer
  }
}

class Renderer {
  constructor() {
    this.count = 1
    this.callback = this.callback.bind(this)
    this._inspector = new InspectorBase()
    this._inspector.setRenderer(this)
    this.library = new NodeLibrary()
  }

  callback() {
    this.count++
    console.log('callback', this.count, this.library.someMap.has('x'))
  }
}

const renderer = new Renderer()
renderer.callback()
console.log('inspector', renderer._inspector._renderer === renderer)
