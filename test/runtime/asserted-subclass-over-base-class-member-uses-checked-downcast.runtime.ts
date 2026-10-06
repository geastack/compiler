// `(base as Derived).b = 5` where `base: Base` and `b` is declared only on
// `Derived`: the assertion names a descendant of the receiver's class and the
// member exists only there, so the access is a typed field load/store through
// the checked downcast -- never a boxed `nativeDynamicSet`/`nativeDynamicGet`.
// A value that is not a `Derived` is the checked downcast's named abort. A
// member `Base` declares (`a`) keeps its ordinary direct access.
class Base {
  a = 0
}
class Derived extends Base {
  b = 1
}
const base: Base = new Derived()
;(base as Derived).b = 5
;(base as Derived).a = 3
console.log('b=' + (base as Derived).b + ' a=' + (base as Base).a)
const plain: Base = new Base()
;(plain as Derived).b = 7
console.log('wrote')
//! expect: b=5 a=3
//! expect-abort
//! emitted-lacks: nativeDynamicSet
//! emitted-lacks: nativeDynamicGet
