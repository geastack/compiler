// @ts-nocheck
// A helper keeps `let _effects = []`, refills it only through a `setEffects`
// the engine object forwards (`@param {Array} effects`) and nothing calls, and
// runs `_effects[ i ].run( engine, ... )`. Read as `any`, that call handed the
// engine to unknown code, which demanded full reflection of the engine --
// including writing its `@type {Object}` `state` and `properties` records back
// from a dynamic value, which their function-valued fields cannot be. The
// array never holds anything, so each element read is `undefined` and the
// member lookup throws before the engine argument is evaluated.

function State() {
  const depth = {
    reversed: false,
    setReversed(value) {
      this.reversed = value
    },
    getReversed() {
      return this.reversed
    }
  }
  let blending = 0
  function setBlending(value) {
    blending = value
  }
  function currentBlending() {
    return blending
  }
  return { buffers: { depth: depth }, setBlending: setBlending, currentBlending: currentBlending }
}

function Properties() {
  let properties = new WeakMap()
  function get(object) {
    let map = properties.get(object)
    if (map === undefined) {
      map = {}
      properties.set(object, map)
    }
    return map
  }
  function has(object) {
    return properties.has(object)
  }
  function dispose() {
    properties = new WeakMap()
  }
  return { get: get, has: has, dispose: dispose }
}

class Engine {
  constructor() {
    const _this = this
    this.mode = 0
    let state, properties
    function init() {
      state = new State()
      properties = new Properties()
      /** @type {Object} */
      _this.state = state
      /** @type {Object} */
      _this.properties = properties
    }
    init()
    const output = new Output()
    this.output = output
    /**
     * @param {Array} effects
     */
    this.setEffects = function (effects) {
      output.setEffects(effects || [])
    }
    this.finish = function () {
      return output.end(_this)
    }
  }
}

function Pass(engine) {
  this.run = function (key) {
    const _state = engine.state
    _state.setBlending(3)
    _state.buffers.depth.setReversed(true)
    const entry = engine.properties.get(key)
    entry.flag = 'on'
    return _state.buffers.depth.getReversed() + ' ' + _state.currentBlending() + ' ' + engine.properties.has(key)
  }
}

function Output() {
  let _effects = []
  this.setEffects = function (effects) {
    _effects = effects
  }
  this.end = function (engine) {
    engine.mode = 4
    for (let i = 0; i < _effects.length; i++) {
      const effect = _effects[i]
      effect.run(engine)
    }
    return _effects.length + engine.mode
  }
}

const engine = new Engine()
const pass = new Pass(engine)
const key = {}
console.log(pass.run(key), engine.finish())

//! expect: true 3 true 4
//! emitted-lacks: makeDocumentViewWithOrigin

export {}
