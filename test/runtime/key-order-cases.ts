//! expect: plain          name,age,zip
//! expect: integerish     2,10,b,a
//! expect: twoSpreads     name,age
//! expect: spreadThenOwn  age,name
//! expect: ownThenSpread  name,age
// The three spread cases were `known-wrong` until the member order stopped
// coming from `getPropertiesOfType`. TypeScript's property table for a spread
// type reports `age,name` where the runtime creates `name,age`: its order is an
// authority on the TYPE and not on enumeration, and the literal's own syntax is
// the only thing that states what the program builds. `structural.ts`'s
// `creationOrderedProperties` reads it from there, and all five lines now match
// node exactly.
//
// The runner FAILING when these stopped reproducing is what surfaced it, which
// is the whole argument for recording a defect rather than deleting it.
const base = { name: 'a' }
const extra = { age: 1 }

// 1. plain literal, declaration order
const plain = { name: 'a', age: 1, zip: 2 }
// 2. spread then spread
const twoSpreads = { ...base, ...extra }
// 3. spread then own property
const spreadThenOwn = { ...extra, name: 'a' }
// 4. own property then spread
const ownThenSpread = { name: 'a', ...extra }
// 5. integer-like keys must come FIRST, ascending, whatever the source order
const integerish = { b: 1, 10: 2, a: 3, 2: 4 }

console.log('plain          ' + Object.keys(plain).join(','))
console.log('twoSpreads     ' + Object.keys(twoSpreads).join(','))
console.log('spreadThenOwn  ' + Object.keys(spreadThenOwn).join(','))
console.log('ownThenSpread  ' + Object.keys(ownThenSpread).join(','))
console.log('integerish     ' + Object.keys(integerish).join(','))
