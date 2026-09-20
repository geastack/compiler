//! expect: direct 12 21
//! expect: detached 14 24
//! emitted-lacks: gea_cpp_value

// Scalar boxing in generated reflection getters is separate from this call
// path: the union, receiver, method and result must keep native carriers.

class Root {
  value = 1
  read(delta: number): number {
    return this.value + delta
  }
}
class Left extends Root {
  left = true
}
class Right extends Root {
  right = true
}
class Specialized extends Left {
  override read(this: Root, delta: number): number {
    return this.value * 10 + delta
  }
}

function invoke(object: Left | Right, delta: number): number {
  return object.read(delta)
}
function detached(object: Left | Right, replacement: Root): number {
  const method = object.read
  return method.call(replacement, 4)
}
const special = new Specialized()
const ordinary = new Right()
ordinary.value = 20
console.log('direct', invoke(special, 2), invoke(ordinary, 1))
console.log('detached', detached(special, new Root()), detached(ordinary, ordinary))
