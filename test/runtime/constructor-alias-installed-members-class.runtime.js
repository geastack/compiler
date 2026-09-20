// @ts-nocheck
//! expect: true 1 2
//! emitted-has: gea::Ref<gea_record_type_31> shadowMap;
//! emitted-has: ((*gea_e->c0))->shadowMap = ((*gea_e->c1));
//! emitted-has: static inline bool gea_present_shadowMap = true;
//! emitted-lacks: gea_writeOwnField(
//! emitted-lacks: gea::nativeDynamicSet
// The real WebGLRenderer.js is not a bare constructor function (see the
// sibling constructor-alias-installed-members.runtime.js) -- it is an ES6
// class whose `constructor(...)` keeps the same `const _this = this` alias
// and installs its data slots (`shadowMap`, `capabilities`, `extensions`,
// `properties`, `renderLists`, `state`, `info`) through it from a nested
// helper. `constructorInstalledMemberWritesOf`'s class arm walks the class's
// own `constructor` method body as the comparison frame instead of a
// function's whole body; this fixture is the class-spelled twin of the
// function fixture to pin that arm at runtime.
//
// The struct-field-layout half of this fix lives in `structural.ts`'s
// `classInstanceBodyOf`, which now also consults
// `constructorInstalledMemberDeclarationsOf` and gives `shadowMap` a real
// native struct field with the type its one write set proves, instead of
// leaving it to the fully dynamic `gea_readOwnField`/`gea_writeOwnField`
// expando protocol. A blanket `emitted-lacks: gea::Value` cannot pin this:
// every class in this compiler emits a boilerplate doc comment ("as a boxed
// `gea::Value` reads them") on its dynamic-property-protocol methods
// regardless of whether any field is actually dynamic, so that substring is
// present in EVERY program with a class, fixed or not. The precise pin is
// instead: the struct declares `shadowMap` as a native `gea::Ref<...>` field
// (first `emitted-has`), the alias-installed write compiles to a direct
// native-field store using the exact same
// `<field> = <value>; gea_present_<field> = true;` shape the literal
// `this.info =` / `this.render =` writes above it use (second
// `emitted-has`), and the file never falls back to the dynamic expando
// write path at all (`emitted-lacks` on the two call forms that path uses).
class R {
  constructor(p) {
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
