//! expect: before true 11
//! expect: replace true false true 42 43 44 13
//! expect: own 91 42
//! expect: restored true 12 92
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class MutablePrototypeBase {
  bias = 10
  hook(delta: number): number {
    return this.bias + delta
  }
}
class MutablePrototypeChild extends MutablePrototypeBase {}
const saved = MutablePrototypeBase.prototype.hook
const first = new MutablePrototypeChild()
console.log('before', first.hook === saved, first.hook(1))
const replacement = (delta: number): number => 40 + delta
MutablePrototypeBase.prototype.hook = replacement
const second = new MutablePrototypeChild()
console.log(
  'replace',
  first.hook === replacement,
  first.hook === saved,
  second.hook === replacement,
  first.hook(2),
  second.hook(3),
  MutablePrototypeChild.prototype.hook.call(first, 4),
  saved.call(first, 3)
)
first.hook = (delta: number): number => 90 + delta
console.log('own', first.hook(1), second.hook(2))
MutablePrototypeBase.prototype.hook = saved
console.log('restored', second.hook === saved, second.hook(2), first.hook(2))
