// @ts-nocheck
// A 3D scene-graph library's GPU-state and GPU-properties records, replaced by unknown
// code after the renderer escapes. Two function fields have frames the plain
// checked adapter does not cover: `texImage2D` forwards `arguments`, so its
// frame is one packed rest slot (a closed tuple record, not an Array), and
// `update` takes a union of related classes as an argument. The typed
// renderer keeps calling both through the replacement.
class Material {
  constructor(name) {
    this.name = name
  }
}
class MeshMaterial extends Material {
  constructor(name, side) {
    super(name)
    this.side = side
  }
}

const gl = {
  /** @param {number} target @param {number} level @param {string} format */
  texImage2D(target, level, format) {
    log.push('gl:' + target + ':' + level + ':' + format)
  }
}
const log = []

function State() {
  function texImage2D() {
    gl.texImage2D(...arguments)
  }
  function update(object, key, value) {
    log.push('native:' + object.name + ':' + key + ':' + value.name)
  }
  return { texImage2D: texImage2D, update: update }
}

class Renderer {
  constructor() {
    const _this = this
    let state
    function init() {
      state = new State()
      /** @type {Object} */
      _this.state = state
    }
    init()
    this.draw = function () {
      _this.state.texImage2D(1, 2, 'rgba')
      const base = new Material('base')
      _this.state.update(base, 'next', new MeshMaterial('mesh', 2))
      _this.state.update(new MeshMaterial('front', 0), 'next', base)
    }
  }
}

const renderer = new Renderer()
renderer.draw()

const plugins = JSON.parse('[0]')
plugins[0] = function (target) {
  target.state = {
    texImage2D() {
      let text = 'dyn:' + arguments.length
      for (let index = 0; index < arguments.length; index++) text += ':' + arguments[index]
      log.push(text)
    },
    update(object, key, value) {
      log.push('dyn:' + object.name + ':' + key + ':' + value.name + ':' + (value instanceof MeshMaterial))
    }
  }
}
plugins[0](renderer)
renderer.draw()
console.log(log.join(' '))

//! expect: gl:1:2:rgba native:base:next:mesh native:front:next:base dyn:3:1:2:rgba dyn:base:next:mesh:true dyn:front:next:base:false

export {}
