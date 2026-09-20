// A descriptor value is narrower than the shared class-family layout that
// stores it: `direct` is optional on the root, while sibling definitions make
// `mixed` an optional tagged union. Both must be materialized into those
// native carriers before the fixed-descriptor helper is called.
//
// TypeScript infers a JS class's property set from `this.x = ...` assignments
// only; `Object.defineProperties(this, { direct: { value } })` declares
// nothing as far as the checker is concerned, even though it is the same act.
// `FixedNumberBranch` gets `mixed` for free because it assigns it plainly --
// which is the whole asymmetry this fixture is standing on.
//
// So `define-property-source-transform.ts` states the declaration the
// descriptor makes, in the one spelling that declares WITHOUT installing
// anything: `/** @type {(typeof descriptor)["value"]} */ this.direct;`, a bare
// typed read. An earlier attempt at this was reverted because the declaration
// left `Object.keys` reporting a key node does not report -- not because the
// declaration was wrong, but because `class-lifecycle.ts` read only the
// assignment spelling, so the class layout had no `define-field` for the
// member and the definition could not tell that it was CREATING the property.
// It took the redefine arm and every omitted attribute stayed at the field's
// default `true`. Both spellings now publish the same initializer-less event,
// which is what makes the definition the creation and an omitted `enumerable`
// `false` -- the sibling `fixed-field-define-property.runtime.js` is the
// enumeration half of that same fact.
//! emitted-has: applyNativeFixedDataDescriptor
class FixedPayload {
  /** @param {number} value */
  constructor(value) {
    this.value = value
  }
}

class FixedRoot {}

class FixedReferenceBranch extends FixedRoot {
  /** @param {FixedPayload} value */
  constructor(value) {
    super()
    Object.defineProperties(this, {
      direct: { value },
      mixed: { value }
    })
  }
}

class FixedNumberBranch extends FixedRoot {
  /** @param {number} value */
  constructor(value) {
    super()
    this.mixed = value
  }
}

const fixedReference = new FixedReferenceBranch(new FixedPayload(41))
const fixedNumber = new FixedNumberBranch(7)
console.log(fixedReference.direct.value, fixedReference.mixed.value, fixedNumber.mixed)
//! expect: 41 41 7

try {
  fixedReference.direct = new FixedPayload(99)
} catch (error) {
  console.log(error instanceof Error ? error.name : 'unexpected', fixedReference.direct.value)
}
//! expect: TypeError 41
