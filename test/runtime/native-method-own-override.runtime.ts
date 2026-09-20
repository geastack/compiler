//! expect: initial true 11 21
//! expect: arrow true false 42 43 44 45
//! expect: saved 22 23 21
//! expect: ordinary true 15 25 16
//! expect: delete true true 11 21
//! expect: super 99 11
//! expect: union 42 72.5 true false
//! expect: union-pair false true
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class Base {
  bias = 1
  hook(delta: number): number {
    return this.bias + delta
  }
}
class Child extends Base {}
class Override extends Base {
  hook(delta: number): number {
    return super.hook(delta) + 100
  }
  original(delta: number): number {
    return super.hook(delta)
  }
}
function throughBase(value: Base, delta: number): number {
  return value.hook(delta)
}

const a = new Child()
const b = new Child()
a.bias = 10
b.bias = 20
const saved = a.hook
console.log('initial', a.hook === b.hook, throughBase(a, 1), throughBase(b, 1))
const arrow = (delta: number): number => 40 + delta
a.hook = arrow
const applied: [number] = [4]
const bound = a.hook.bind(b)
console.log('arrow', a.hook === arrow, a.hook === b.hook, throughBase(a, 2), a.hook.call(b, 3), a.hook.apply(b, applied), bound(5))
const savedArguments: [number] = [3]
console.log('saved', saved.call(b, 2), saved.apply(b, savedArguments), throughBase(b, 1))
function ordinary(this: Base, delta: number): number {
  return this.bias + delta
}
a.hook = ordinary
console.log('ordinary', a.hook === ordinary, throughBase(a, 5), a.hook.call(b, 5), a.hook.bind(a)(6))
console.log('delete', Reflect.deleteProperty(a, 'hook'), a.hook === b.hook, throughBase(a, 1), throughBase(b, 1))
const overridden = new Override()
overridden.bias = 10
overridden.hook = () => 99
console.log('super', throughBase(overridden, 1), overridden.original(1))

class Other {
  hook(delta: number): number {
    return 30 + delta
  }
}
function throughUnion(value: Base | Other): number {
  return value.hook(2)
}
function sameUnion(value: Base | Other, callback: (delta: number) => number): boolean {
  return value.hook === callback
}
function sameUnionPair(left: Base | Other, right: Base | Other): boolean {
  return left.hook === right.hook
}
const other = new Other()
a.hook = arrow
other.hook = (delta: number): number => 70.5 + delta
console.log('union', throughUnion(a), throughUnion(other), sameUnion(a, arrow), sameUnion(other, arrow))
const differentUnionPair = sameUnionPair(a, other)
other.hook = arrow
console.log('union-pair', differentUnionPair, sameUnionPair(a, other))
