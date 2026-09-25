// three.js brands its math classes from a static block --
// `static { Vector3.prototype.isVector3 = true }` -- so every instance reads
// the flag through its prototype. The write lands in the class prototype
// object's own property table, and an instance read that misses the
// instance's own properties and every declared member walks it.
// (three's own JavaScript is `class-static-block-prototype-flag.runtime.js`;
// here TypeScript needs the casts, since the class declares no `isV`.)
//! expect: isV true true
//! expect: own x | true

class V {
  x = 1
  static {
    ;(V.prototype as any).isV = true
  }
}
const v: any = new V()
console.log('isV', v.isV === true, (new V() as any).isV)
console.log('own', Object.keys(v).join(','), '|', 'isV' in v)
