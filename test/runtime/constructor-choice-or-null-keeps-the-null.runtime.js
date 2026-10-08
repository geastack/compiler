//! expect: or null true true Base Derived
//! expect: nullish true true Base Derived
//! expect: conditional true true Base Derived
//! expect: built none Base Derived
// three's `NodeLibrary.getLightNodeClass`: `return this.lightNodes.get( light )
// || null` over a registry of class constructors. The value is one of the
// registered classes or the right-hand `null`. The checker reduces `typeof
// Base | typeof Derived` to `typeof Base`, so the compiler keeps each class
// by its own identity; only the LEFT operand's absence is dropped, because
// the right operand is what an absent left evaluates to.
class Base {
  constructor() {
    this.size = 1
  }
}
class Derived extends Base {}
/** @type {Map<number, typeof Base | typeof Derived>} */
const registry = new Map()
registry.set(1, Base)
registry.set(2, Derived)
/** @param {number} key @return {typeof Base | typeof Derived | null} */
function orNull(key) {
  return registry.get(key) || null
}
/** @param {number} key @return {typeof Base | typeof Derived | null} */
function nullish(key) {
  return registry.get(key) ?? null
}
/** @param {number} key @return {typeof Base | typeof Derived | null} */
function conditional(key) {
  return key === 1 ? Base : key === 2 ? Derived : null
}
/** @param {(key: number) => (typeof Base | typeof Derived | null)} pick */
function describe(pick) {
  const none = pick(0)
  const base = pick(1)
  const derived = pick(2)
  return [none === null, base === Base && derived === Derived, base === null ? '-' : base.name, derived === null ? '-' : derived.name].join(
    ' '
  )
}
/** @param {number} key */
function build(key) {
  const Chosen = registry.get(key) || null
  if (Chosen === null) return 'none'
  const made = new Chosen()
  return made instanceof Derived ? 'Derived' : 'Base'
}
console.log('or null', describe(orNull))
console.log('nullish', describe(nullish))
console.log('conditional', describe(conditional))
console.log('built', build(0), build(1), build(2))
