//! expect: built 7 same true
// The present half of `globalthis-as-optional-record.ts`: a feature-detected
// constructor that IS installed reads as that constructor -- `new` on it
// builds the instance, and two reads of the entry are one Function object.
class Box {
  v = 7
}
;(globalThis as unknown as Record<string, unknown>)['BoxCtor'] = Box
const g = globalThis as unknown as { BoxCtor?: new () => { v: number } }
const C = g.BoxCtor
const D = g.BoxCtor
console.log('built', C === undefined ? 'none' : new C().v, 'same', C === D)
