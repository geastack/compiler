// @ts-nocheck
//! expect: function 6 struct 5 5
//! expect: nested 8 struct function

// TSL's `nodeProxyConstructor` (three/src/nodes/tsl/TSLCore.js): a proxy over
// a callable target with `get` and `set` traps and no `apply`, so calling it
// calls the target, while its members are the node instance's. A proxy over
// that proxy with an empty handler forwards every operation to it.
class StructTypeNode {
  constructor() {
    this.label = 'struct'
    this.count = 0
  }
}
const nodeProxyConstructor = (constructorFunction, nodeInstance) => {
  return new Proxy(constructorFunction, {
    get(target, prop, receiver) {
      return Reflect.get(nodeInstance, prop)
    },
    set(target, prop, value) {
      return Reflect.set(nodeInstance, prop, value)
    }
  })
}
const node = new StructTypeNode()
const make = nodeProxyConstructor((x) => x * 2, node)
make.count = 5
console.log(typeof make, make(3), make.label, make.count, node.count)
const outer = new Proxy(make, {})
console.log('nested', outer(4), outer.label, typeof outer)
