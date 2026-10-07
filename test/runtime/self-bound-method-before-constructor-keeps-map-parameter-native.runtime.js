// @ts-nocheck
//! expect: has k true
//! expect: work 1
//! emitted-has: ->has(
//! emitted-lacks: literalPropertyGet<"has">

// The same hand-off as
// `self-bound-receiver-handed-to-a-field-keeps-map-parameter-native.runtime.js`,
// with the bound method declared before the constructor and an inspector
// method that takes no parameter: the renderer is then an argument no
// parameter receives, and the census still has to prove the inspector field
// to keep `library` a native Map.

export {}

class NodeLibrary {
  constructor() {
    this.someMap = new Map([['k', 0]])
    this.addType(1, 'k', this.someMap)
  }

  addType(x, type, library) {
    console.log('has', type, library.has(type))
  }
}

class InspectorBase {
  setRenderer() {}
}

class Renderer {
  work() {
    console.log('work', this.library.someMap.size)
  }

  constructor() {
    this.work = this.work.bind(this)
    this._inspector = new InspectorBase()
    this._inspector.setRenderer(this)
    this.library = new NodeLibrary()
  }
}

const renderer = new Renderer()
renderer.work()
