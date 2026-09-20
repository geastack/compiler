// A member read whose RECEIVER the checker types `any` names no symbol, so
// the checker cannot say which field the read touches. The census can: it
// bound `renderer` from its one call site (`parameter-bindings.ts`) and it
// bound `state` from its writes (`field-bindings.ts`). Before the fix the
// field census only answered a read the CHECKER attributed to a symbol; a
// read through an `any` receiver fell to `memberTypeOf`, read the checker's
// `any` for the field, and refused -- so the census had typed the receiver
// AND the field and still laid the local out as a dynamic box between them.
// Three's `WebGLShadowMap( renderer, objects, capabilities )` is the shape:
// `const _state = renderer.state;` was `gea::Value`, and every
// `_state.setBlending()` went through dynamic lookup and threw on frame one.
// After the fix the member is looked up on the census-resolved receiver and
// answered from the field's own write-set join, so `state` below is the
// native record and the calls are direct.
// `new` on a JS factory returning a literal is `any` to the checker, so the
// `depth` member of the `buffers` literal below is `any` too, while the
// parameter census reads the factory's return and lays the member out as a
// typed record. A read through it must answer from the member's own
// initializer, or the native callable field is boxed to be called.
function DepthBuffer() {
  let reversed = false
  function setReversed(value) {
    reversed = value
  }
  function getReversed() {
    return reversed
  }
  return { setReversed: setReversed, getReversed: getReversed }
}

function State() {
  let blending = 0
  const depthBuffer = new DepthBuffer()
  function setBlending(value) {
    blending = value
  }
  function getBlending() {
    return blending
  }
  return { buffers: { depth: depthBuffer }, setBlending: setBlending, getBlending: getBlending }
}

class Renderer {
  constructor() {
    const _this = this
    let state
    function init() {
      state = new State()
      _this.state = state
    }
    init()
  }
}

/** Untyped on purpose: its one call site is the only statement of what `renderer` is. */
function ShadowMap(renderer) {
  this.render = function () {
    const state = renderer.state
    state.setBlending(3)
    state.buffers.depth.setReversed(true)
    if (state.buffers.depth.getReversed() === true) return state.getBlending() + 1
    return state.getBlending()
  }
}

const renderer = new Renderer()
const shadowMap = new ShadowMap(renderer)
console.log(shadowMap.render())
