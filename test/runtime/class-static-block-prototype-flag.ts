// three.js brands its math classes from a static block --
// `static { Vector3.prototype.isVector3 = true }` -- so every instance reads
// the flag through its prototype. Static blocks run now
// (`class-static-blocks.ts`); what is still missing is a data property on a
// native class's prototype that an instance [[Get]] falls back to (plan step
// 2.6, prototype expandos on native classes). Until then the write is refused
// by name rather than dropped. When 2.6 lands this must print `isV true`,
// as Node does: replace the refusal with `//! expect: isV true`.
//! expect-refusal: property-access:class-prototype:method-only

class V {
  declare isV: boolean
  x = 1
  static {
    V.prototype.isV = true
  }
}
console.log('isV', new V().isV === true)
