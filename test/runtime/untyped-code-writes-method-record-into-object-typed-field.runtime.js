// @ts-nocheck
// A 3D scene-graph library's spelling of the same field: `/** @type {Object} */ _this.state`
// declares the field `any`, and the renderer narrows it from the one record
// its factory builds. Unknown code replacing the record hands the typed
// renderer a value whose function fields it then calls.
function State() {
  let enabled = 0
  function enable(flag) {
    enabled += flag
  }
  function count() {
    return enabled
  }
  return { enable: enable, count: count }
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
      _this.state.enable(2)
      _this.state.enable(3)
      return _this.state.count()
    }
  }
}

const renderer = new Renderer()
console.log(renderer.draw())

let calls = 0
const plugins = JSON.parse('[0]')
plugins[0] = function (target) {
  target.state = {
    enable(flag) {
      calls += flag * 10
    },
    count() {
      return calls + this.base
    },
    base: 1
  }
}
plugins[0](renderer)
console.log(renderer.draw())

//! expect: 5
//! expect: 51

export {}
