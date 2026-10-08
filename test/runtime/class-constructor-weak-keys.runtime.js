// @ts-nocheck
//! expect: point 1 true false
//! expect: spot true | base undefined false
//! expect: twin-b false
//! expect: made true false
//! expect: set true false true
//! emitted-has: gea::WeakMap<gea::ConstructorObject<
//! emitted-has: gea::WeakSet<
//! emitted-lacks: gea::Value::box
// A WeakMap or WeakSet keyed by class objects compares the classes, as `===`
// does: three's NodeLibrary keys its light nodes by light class. A class key
// is its class evaluation, so a copy, a key stored where a base class is
// declared, and the class itself find one entry; a subclass, a same-named
// class and a second evaluation of one class expression are other keys.
class Light {}
class PointLight extends Light {}
class SpotLight extends Light {}

/** @type {WeakMap<typeof Light | typeof PointLight | typeof SpotLight, string>} */
const byClass = new WeakMap()
byClass.set(PointLight, 'point')
const copy = PointLight
byClass.set(copy, 'point')
console.log(byClass.get(PointLight), byClass.has(copy) ? 1 : 0, byClass.has(PointLight), byClass.has(SpotLight))

/** @type {typeof Light} */
const stored = SpotLight
/** @type {WeakMap<typeof Light, string>} */
const byBase = new WeakMap()
byBase.set(stored, 'spot')
console.log(byBase.get(SpotLight), byBase.has(stored), '|', 'base', byBase.get(Light), byBase.has(Light))

const TwinA = (() => class Twin {})()
const TwinB = (() => class Twin {})()
/** @type {WeakMap<typeof TwinA | typeof TwinB, string>} */
const twins = new WeakMap()
twins.set(TwinA, 'twin-a')
twins.set(TwinB, 'twin-b')
twins.delete(TwinA)
console.log(twins.get(TwinB), twins.has(TwinA))

const make = () => class Made {}
const first = make()
const second = make()
/** @type {WeakMap<ReturnType<typeof make>, string>} */
const made = new WeakMap()
made.set(first, 'made')
console.log(made.get(first), made.has(first), made.has(second))

/** @type {WeakSet<typeof PointLight | typeof SpotLight>} */
const seen = new WeakSet()
seen.add(PointLight)
seen.add(PointLight)
const added = seen.has(PointLight) && !seen.has(SpotLight)
seen.delete(PointLight)
seen.add(SpotLight)
console.log('set', added, seen.has(PointLight), seen.has(SpotLight))
