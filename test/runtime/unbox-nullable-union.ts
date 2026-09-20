// A `null` arm inside a union read OUT of a box. `null` has no payload, so the
// read is a verify-then-produce exactly like `undefined`'s -- and no payload is
// not no value: its carrier is `std::nullptr_t`, whose one inhabitant is
// `nullptr`. The conversion deriver used to answer `never` for this arm on the
// premise that "the runtime does not distinguish null with an exact tag", which
// is false -- `gea::Value::Tag::Null` is exactly that tag -- and a single
// `never` arm makes the whole sum `never`, so every union with a `null` arm was
// unreachable from a dynamic source.
const pick = (raw: any): number | string | null | undefined => raw as number | string | null | undefined

// Deliberately does NOT narrow to a present arm. Reading a union DOWN to one
// of its arms is a separate, still-unmet conversion
// (`binding-read-conversion:tagged-union(...)->scalar(number)`), which the three.js app
// also wants; what this program pins is the boxed read INTO the union, and
// telling the three absent/present states apart is enough to prove every arm
// was built from the right tag.
const describe = (value: number | string | null | undefined): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return 'present'
}

console.log(`from-null=${describe(pick(null))}`)
console.log(`from-undefined=${describe(pick(undefined))}`)
console.log(`from-number=${describe(pick(7))}`)
console.log(`from-string=${describe(pick('hi'))}`)

//! expect: from-null=null
//! expect: from-undefined=undefined
//! expect: from-number=present
//! expect: from-string=present
//! emitted-has: unboxNullValue
