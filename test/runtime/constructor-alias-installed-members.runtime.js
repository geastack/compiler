// @ts-nocheck
//! expect: true 1 2
// WebGLRenderer's own shape: a plain JS constructor function keeps a
// `const _this = this` alias and installs most of its DATA slots through
// that alias instead of the literal keyword -- often from inside a nested
// helper (`initGLContext`), which is exactly how `WebGLRenderer.js` installs
// `shadowMap`, `capabilities`, `extensions`, `properties`, `renderLists`,
// `state` and `info`. A member-declaration authority that only recognises
// the bare `this` keyword sees no member at all for a key written this way,
// which refused the whole receiver chain's INVOCATION proof (`renderer.render()`
// calling `shadowMap.render()` calling back into `renderer.setClearColor()`)
// before this fix -- that closure now certifies and the program runs and
// prints correctly. No native-field pin here: `structural.ts`'s
// `classInstanceBodyOf` -- the struct-field-layout census that decides NATIVE
// vs boxed storage for `shadowMap` -- was extended to consult the same
// alias-installed-member fact, but only for a REAL `class`, gated on
// `ts.isClassLike(location)` at its one call site. A bare constructor
// FUNCTION like this `R` never reaches that call site at all (the checker's
// `class-instance`/`class-constructor` structural anchor only fires for
// `ts.isClassLike` declarations; a constructor function's instance type is
// laid out by a different, still-unextended path), so this program still
// emits a boxed expando write for `_this.shadowMap = shadowMap`. See the
// class-spelled twin fixture (`constructor-alias-installed-members-class.
// runtime.js`), which pins the fixed case with precise `emitted-has`/
// `emitted-lacks` directives on the native struct field and store site (a
// blanket `emitted-lacks: gea::Value` does not work for any class-bearing
// program, fixed or not -- see that fixture's comment for why), and the
// root-D report for the remaining constructor-function gap.
function R(p) {
  const _this = this
  let shadowMap
  this.info = { calls: 0 }
  this.render = function (s) {
    _this.info.calls++
    shadowMap.render(s)
  }
  this.setClearColor = function (c) {
    _this.info.calls += c
  }
  function initGLContext() {
    shadowMap = new Shadow(_this)
    _this.shadowMap = shadowMap
  }
  initGLContext()
}
function Shadow(renderer) {
  this.render = function (s) {
    renderer.setClearColor(0)
  }
}
function Env(renderer) {
  function get(t) {
    renderer.setClearColor(1)
    return renderer.info
  }
  return { get }
}
const renderer = new R()
const env = Env(renderer)
console.log(renderer.render(1) === undefined, renderer.info.calls, env.get(1).calls)
