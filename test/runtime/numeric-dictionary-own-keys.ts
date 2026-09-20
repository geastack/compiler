//! expect: 1,5,10
//! expect: 1,5,10
//! expect: true false
//! emitted-lacks: gea::Value::box
//! emitted-has: gea::host::ObjectConstructor::keysOf
//! emitted-has: gea::host::ObjectConstructor::ownPropertyNamesOf

// `Object.keys`/`Object.getOwnPropertyNames`/`Object.hasOwn` over a
// NUMBER-keyed dictionary of class instances (`webglTextures`/`programs`
// shape in three.js: `{[id: number]: T}`) used to convert the whole table to
// `dynamic` -- `object-protocol.ts`'s own-key views refused a numeric
// dictionary by name, so the call fell back to the intrinsic's declared
// `(o: object) => string[]` ABI and boxed every member `T` carries. The
// runtime's own `NumericDictionary<V>::canonicalKey` already spells each key
// with the exact ECMA-262 `Number::toString` this backend uses for `${n}`
// interpolation, so there was no unrenderable key left to refuse -- only the
// missing native overloads and the emitter's own gate. Neither `Item` nor its
// label crosses a `gea::Value` anywhere below: `emitted-lacks` pins that, and
// the ascending `1,5,10` (not insertion order `5,1,10`) pins 10.1.11.1's
// integer-key ordering over the canonicalized keys.

class Item {
  constructor(public label: string) {}
}

type ById = { [id: number]: Item }

const table: ById = {}
table[5] = new Item('five')
table[1] = new Item('one')
table[10] = new Item('ten')

console.log(Object.keys(table).join(','))
console.log(Object.getOwnPropertyNames(table).join(','))
console.log(Object.hasOwn(table, 1), Object.hasOwn(table, 2))
