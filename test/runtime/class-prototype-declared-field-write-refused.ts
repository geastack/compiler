// A write to `C.prototype` under a key the class declares as a FIELD
// (`declare isV` is laid out as one) has no native prototype protocol: the
// field belongs to the instance layout. Certification refuses it by name,
// before emission, with the projection's reason.
//! expect-refusal: property-access:class-prototype:method-only
//! expect-refusal: prototype set of isV has no typed method protocol

class V {
  declare isV: boolean
  x = 1
  static {
    V.prototype.isV = true
  }
}
console.log('isV', new V().isV === true)
