//! expect: before-construction 0
//! expect: prototype true true true 12
//! expect: prototype-chain false false true
//! expect: after-construction 1
//! expect: factory true true
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

let constructed = 0
class PrototypeBase {
  bias = 10
  constructor() {
    constructed++
  }
  get unusedAccessor(): number {
    return this.bias
  }
  set unusedAccessor(value: number) {
    this.bias = value
  }
  hook(delta: number): number {
    return this.bias + delta
  }
}
class PrototypeChild extends PrototypeBase {}
const canonical = PrototypeBase.prototype.hook
console.log('before-construction', constructed)
const child = new PrototypeChild()
console.log(
  'prototype',
  canonical === child.hook,
  canonical === PrototypeChild.prototype.hook,
  PrototypeBase.prototype.hook === PrototypeBase.prototype.hook,
  canonical.call(child, 2)
)
console.log(
  'prototype-chain',
  PrototypeBase.prototype instanceof PrototypeBase,
  PrototypeChild.prototype instanceof PrototypeChild,
  PrototypeChild.prototype instanceof PrototypeBase
)
console.log('after-construction', constructed)
function createClass() {
  return class FactoryClass {
    hook(): number {
      return 1
    }
  }
}
const First = createClass()
const Second = createClass()
console.log('factory', First.prototype !== Second.prototype, First.prototype.hook !== Second.prototype.hook)
