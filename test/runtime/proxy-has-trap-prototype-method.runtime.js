// @ts-nocheck
//! expect: has true true
//! expect: field true
//! expect: absent false
//! expect: keys m:true n:true f:true absent:false

// A proxy `has` trap that forwards its key, `Reflect.has(t, k)`, asks the
// native class instance the proxy wraps. The instance holds no own `m`, so
// the answer comes from the class's declared members, then its ancestors', as
// it does for a read through a `get` trap (`proxy-get-trap-prototype-method`);
// a key no class declares is absent.
class A {
  n() {
    return 2
  }
}
class B extends A {
  constructor() {
    super()
    this.f = 1
  }
  m() {
    return 1
  }
}
const b = new B()
const q = new Proxy(b, {
  has: (t, k) => Reflect.has(t, k)
})
console.log('has', 'm' in q, 'n' in q)
console.log('field', 'f' in q)
console.log('absent', 'absent' in q)
const seen = []
for (const key of ['m', 'n', 'f', 'absent']) seen.push(key + ':' + Reflect.has(b, key))
console.log('keys', seen.join(' '))
