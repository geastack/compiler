// `mesh.material as Phong` where `material: Material | Material[]` (three.js):
// the assertion to a class that descends from the union's class arm names that
// arm, so the write is a typed field store through the checked downcast -- never
// a per-arm `nativeDynamicSet` that boxes the value and plants an expando on the
// array arm. A value that is not that class (the array arm, or a plain Base held by the
// class arm) is the checked downcast's named abort, never a silent write.
class Base {
  a = 0
}
class Derived extends Base {
  b = 1
}
class Holder {
  m: Base | Base[]
  constructor(m: Base | Base[]) {
    this.m = m
  }
}
const h = new Holder(new Derived())
;(h.m as Derived).b = 5
console.log('b=' + (h.m as Derived).b)
const arr = new Holder([new Base()])
try {
  ;(arr.m as Derived).b = 7
  console.log('array wrote')
} catch (e) {
  console.log('array arm refused')
}
// The class arm holds a plain Base: the field store would land past its bytes.
const plain = new Holder(new Base())
;(plain.m as Derived).b = 7
console.log('wrote')
//! expect: b=5
//! expect: array arm refused
//! expect-abort
//! emitted-lacks: nativeDynamicSet
