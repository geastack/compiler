// @ts-nocheck
//! expect-refusal: "Object.assign" of a "record(
// three's `ShaderNodeProxy` (`nodes/tsl/TSLCore.js`), reduced. The checker
// types `settings = null` as `null`, so inside `if ( settings !== null )` the
// source is `never` and `Object.assign( node, settings )` is `any & never`,
// which is `never`: the call minted no value, and `nodeObject( ... )` refused
// its argument as "a value produced by a different owner needs capture
// lowering". The callers pass records, and `Object.assign` returns its target,
// so the call's result is the `any` target's own. That lowers, and the program
// now stops at the emitter's own named refusal: copying a struct's fields into
// a dynamic target is not rendered yet.
class N {
  constructor() {
    this.k = 1
  }
}
const nodeObject = (node) => node
const ShaderNodeProxy = function (NodeClass, settings = null) {
  function assignNode(node) {
    if (settings !== null) {
      node = nodeObject(Object.assign(node, settings))
    }
    return node
  }
  return () => assignNode(new NodeClass())
}
const make = new ShaderNodeProxy(N, { intent: true, extra: 2 })
console.log(make().extra)
