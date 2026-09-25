// @ts-nocheck
//! expect: function 1
//! expect: function 2 3
//! expect: undefined

// A proxy `get` trap that forwards the key into an untyped local, `t[k]` or
// `Reflect.get(t, k)`, reads a class METHOD off the instance. The instance
// holds no own `m`, so the read takes the class's declared members, then its
// ancestors', as a boxed read does; a key no class declares stays undefined.
class A {
  n() {
    return 2
  }
}
class B extends A {
  m() {
    return 1
  }
  k() {
    return 3
  }
}
const b = new B()
const p = new Proxy(b, {
  get: (t, k) => {
    let v
    v = t[k]
    return v
  }
})
console.log(typeof p.m, p.m.call(b))
const q = new Proxy(b, {
  get: (t, k) => {
    let v
    v = Reflect.get(t, k)
    return v
  }
})
console.log(typeof q.n, q.n.call(b), q.k.call(b))
console.log(typeof p.absent)
