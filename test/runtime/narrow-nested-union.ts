// Narrowing does not stop at the top level.
//
// A cell typed `string | number | boolean | null | undefined` is not a flat
// five-arm carrier: the representation layer tags the two absences as arms of
// their own and leaves the rest as a NESTED union, so the carrier is
// `undefined | null | (string|number|boolean)`. A guard past the absences lands
// inside that nested arm -- two steps -- and both the pairing
// (`conversion/build.ts`) and the admission (`targets/cpp/conversions.ts`)
// looked only one step, while `emit-narrowing.ts` already recursed for the
// sub-union case and had no obligation counterpart.
const pick = (raw: any): string | number | boolean | null | undefined => raw as string | number | boolean | null | undefined

// Narrowed all the way to ONE inner arm.
const describe = (value: string | number | boolean | null | undefined): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return `number:${value}`
  if (typeof value === 'boolean') return `boolean:${value}`
  return `string:${value}`
}

// Narrowed to the same OUTER shape with a smaller inner union: ruling out
// `boolean` leaves `string | number | null | undefined`, three arms again with
// a two-arm union inside.
const narrower = (value: string | number | boolean | null | undefined): string | number | null | undefined =>
  typeof value === 'boolean' ? null : value

console.log(`from-null=${describe(pick(null))}`)
console.log(`from-undefined=${describe(pick(undefined))}`)
console.log(`from-number=${describe(pick(7))}`)
console.log(`from-boolean=${describe(pick(true))}`)
console.log(`from-string=${describe(pick('hi'))}`)
console.log(`narrower-number=${String(narrower(pick(3)))}`)
console.log(`narrower-string=${String(narrower(pick('s')))}`)
console.log(`narrower-boolean=${String(narrower(pick(false)))}`)

//! expect: from-null=null
//! expect: from-undefined=undefined
//! expect: from-number=number:7
//! expect: from-boolean=boolean:true
//! expect: from-string=string:hi
//! expect: narrower-number=3
//! expect: narrower-string=s
//! expect: narrower-boolean=null
