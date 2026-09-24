//! expect: json {"w":1,"v":8,"dyn":7} {"count":2,"label":"x","on":true,"late":9} {"base":3,"added":4} {"inner":{"depth":5}} {"a":1}
//! expect: entries listed=6;more=7 b=2
//! expect: assign {"copied":8} {"c":3}
//! expect: direct 11 ["{\"direct\":11}","{\"d\":4}"]

// A class field nothing in the program spells, read only by a host function.
//
// The shake drops an effect-free field initializer when no operation can read
// the field: none spells its key, none enumerates the class, none reads it by a
// runtime key. `JSON.stringify`, `Object.entries` and `Object.assign` do all of
// that from host code, where no operation shows it, so `class Box { w = 1 }`
// handed to them as `object` printed `{"w":0}`: the initializer never ran and
// the serializer read the member C++ had zeroed.
//
// Every class here has its own field names on purpose. A key spelled on a
// class keeps that class's initializers, so sharing one would hide the defect
// for every other class that declares it.
const s = (t: string) => t + ''
const json = (o: object) => JSON.stringify(o)
// Sorted: `Object.entries` lists a subclass's own fields before its base's,
// where the language lists them in the order the initializers ran. That is the
// property-order defect, not this one, and this program pins only the values.
const entries = (o: object) =>
  Object.entries(o)
    .map(([k, v]) => k + '=' + String(v))
    .sort()
    .join(';')
const assigned = (o: object) => JSON.stringify(Object.assign({}, o))

// The research repro: a computed-key write and a later optional-field write.
class Box {
  w = 1
  v?: number
}
const box = new Box()
;(box as object as Record<string, number>)[s('dyn')] = 7
box.v = 8

// Initializers of three carriers, an optional field with none, and a field the
// constructor writes instead.
class Mixed {
  count = 2
  label = 'x'
  on = true
  none?: string
  late: number
  constructor() {
    this.late = 9
  }
}
class Base {
  base = 3
}
class Derived extends Base {
  added = 4
}
// A class the host reaches only through another class's field.
class Inner {
  depth = 5
}
class Outer {
  inner = new Inner()
}
console.log('json', json(box), json(new Mixed()), json(new Derived()), json(new Outer()), json({ a: 1 }))

class Listed {
  listed = 6
}
class ListedSub extends Listed {
  more = 7
}
console.log('entries', entries(new ListedSub()), entries({ b: 2 }))

class Copied {
  copied = 8
}
console.log('assign', assigned(new Copied()), assigned({ c: 3 }))

// A field the program also reads directly was never affected; it pins that the
// direct read and the host read agree.
class Direct {
  direct = 11
}
const direct = new Direct()
console.log('direct', direct.direct, JSON.stringify([json(direct), json({ d: 4 })]))
export {}
