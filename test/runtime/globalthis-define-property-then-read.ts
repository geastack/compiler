//! expect-refusal: no runtime conversion is installed from constructor-family
// `Object.defineProperty(globalThis, name, { value })` over a script-level
// `var` with a literal key and a plain `value` descriptor is RECOGNISED
// (`normalize/script-global-redefinition.ts`) and lowered as a write to the
// var's own cell, so both spellings of the read see one writer. What refuses
// this program is that write's type: `Other` is not a member of `Marker`'s
// constructor family, so the store has no conversion into the cell. The
// "two writers this backend does not reconcile" refusal remains for the
// redefinitions the census cannot place (a computed key, an accessor
// descriptor), which is a different program from this one.
// `Object.defineProperty(globalThis, name, { value })` over a script-level
// `var`: 9.1.1.4.17 makes the var an own property of the global object, so
// the redefinition replaces what every later read -- bare or through
// `globalThis` -- must see. This backend does not reconcile the two writers,
// so it refuses the reads rather than answer with the value the redefinition
// replaced (which is what reading the var's own cell would do).
class Marker {}
class Other {}
var Marker2 = Marker
Object.defineProperty(globalThis, 'Marker2', { value: Other })
console.log(globalThis.Marker2 === Other)
console.log(Marker2 === Other)
