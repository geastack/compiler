//! expect: pair 1 2 | listed listed,more
//! expect: mixed listed=6 | listed=6;more=7 | b=2 | 1 2 1
//! expect: chain a=1 | a=1;b2=2 | a=1;b2=2;c=3 | z=9
//! expect: middle a=1;b2=2;m=4 | a=1;b2=2;m=4;n=5 | y=8
//! expect: typed listed=6;more=7 | listed=6 | listed=6
//! expect: keys listed,more | b

// `Object.entries` of a subclass instance, handed to a helper that also
// receives its base class.
//
// The helper's parameter is carried by the base class's struct, and a
// subclass instance reaches it through the derived C++ type. The entries
// renderer listed the base's declared fields and asked the runtime only
// whether the object had keys no declared field names -- an expando or an
// index-signature entry. A subclass's own fields are neither, so
// `Object.entries(new S())` listed `listed` alone (`1 1` for the lengths).
//
// With a plain object in the same helper the defect was worse: the write set
// `L`, `S`, `{ b: 2 }` has no single covering type, and a subclass beside its
// base was refused as an overlapping union arm, so the parameter fell back to
// its declared `object` -- an empty record every argument was copied into.
// Every entry list came out empty, the plain object's too.
//
// Every helper sorts: the property-order defect lists a subclass's own fields
// before its base's. This program pins the sets, not the order. Every helper
// is its own function, so each has its own set of callers.
class L {
  listed: number
  constructor() {
    this.listed = 6
  }
}
class S extends L {
  more: number
  constructor() {
    super()
    this.more = 7
  }
}
const count = (o: object) => Object.entries(o).length
const keys = (o: object) => Object.keys(o).sort().join(',')
console.log('pair', count(new L()), count(new S()), '|', keys(new L()), keys(new S()))

const mixed = (o: object) =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + String(v))
    .sort()
    .join(';')
const mixedCount = (o: object) => Object.entries(o).length
console.log(
  'mixed',
  mixed(new L()),
  '|',
  mixed(new S()),
  '|',
  mixed({ b: 2 }),
  '|',
  mixedCount(new L()),
  mixedCount(new S()),
  mixedCount({ b: 2 })
)

// A three-class chain with initializer fields, beside a plain object.
class A {
  a = 1
}
class B extends A {
  b2 = 2
}
class C extends B {
  c = 3
}
const chain = (o: object) =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + String(v))
    .sort()
    .join(';')
console.log('chain', chain(new A()), '|', chain(new B()), '|', chain(new C()), '|', chain({ z: 9 }))

// The root is never passed: the middle class carries its own subclass.
class M extends B {
  m = 4
}
class N extends M {
  n = 5
}
const middle = (o: object) =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + String(v))
    .sort()
    .join(';')
console.log('middle', middle(new M()), '|', middle(new N()), '|', middle({ y: 8 }))

// A parameter the program typed as the base class, and a subclass adding nothing.
class Plain extends L {}
const typed = (o: L) =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + String(v))
    .sort()
    .join(';')
console.log('typed', typed(new S()), '|', typed(new L()), '|', typed(new Plain()))

const keyed = (o: object) => Object.keys(o).sort().join(',')
console.log('keys', keyed(new S()), '|', keyed({ b: 2 }))
export {}
