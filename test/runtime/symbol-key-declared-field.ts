// SYMBOL-KEYED FIELDS DECLARED DIRECTLY ON A CLASS AND ON A PLAIN RECORD,
// exercising the full own-property protocol the declared-field dispatch
// (`records.ts`'s `gea::detail::declaredSymbolId` branch) must answer for --
// not just read/write, which `symbol-keyed-class-field-declarations.ts`
// already pins.
//
// A class field declared without an initializer is, per the language's own
// class-fields semantics, an OWN property from construction on (present,
// value `undefined`) -- it does not start absent. Genuine absence is what
// `delete` produces, and what a later write must undo, which is the
// `gea_present_` flag's whole job; this file drives that cycle explicitly
// rather than assuming a declared field starts absent.
//
// Every READ after a `delete` goes through a helper function taking the
// object as a plain parameter, rather than `p[keyA]` inline: TypeScript's own
// control-flow narrowing for a COMPUTED element access does not treat
// `delete p[keyA]` as invalidating the narrowing `p[keyA] = 10` established
// (verified directly against `tsc`: `p.a` -- a spelled name -- IS
// re-widened to `number | undefined` after `delete p.a`, but `p[keyA]` stays
// narrowed to `number`), so a direct re-read here would ask this backend to
// certify a checker-typed `number` that is actually absent -- exactly what
// `gea::host::presentOrThrow` exists to refuse, correctly, as a defect
// upstream of this file rather than in the declared-field dispatch this file
// means to test. Reading through a freshly-typed parameter sidesteps that TS
// quirk instead of asking the compiler to paper over it.
import { Holder, readShared, sharedKey, writeShared } from './_symbol-key-declared-field-shared'

const keyA = Symbol('keyA')
const keyB = Symbol('keyB')

class Pair {
  [keyA]: number | undefined
  [keyB]: string | undefined
}

const readA = (o: Pair): number | undefined => o[keyA]
const readB = (o: Pair): string | undefined => o[keyB]

const p = new Pair()

// Present (value undefined) immediately after construction -- real
// class-field semantics, not sidecar absence.
console.log('constructed=' + String(keyA in p) + ' ' + String(readA(p)))
//! expect: constructed=true undefined

p[keyA] = 10
p[keyB] = 'hi'

// Two distinct symbols on one instance do not alias each other's storage.
console.log('collide=' + readA(p) + ' ' + readB(p))
//! expect: collide=10 hi

console.log('hasOwnA=' + String(p.hasOwnProperty(keyA)) + ' hasOwnB=' + String(p.hasOwnProperty(keyB)))
//! expect: hasOwnA=true hasOwnB=true

// NOTE: `Object.getOwnPropertySymbols` is not exercised here -- it is not yet
// implemented for ANY receiver (native or dynamic): `intrinsicOwnKeyQueryOf`
// recognizes the call syntactically (`intrinsic-property-call.ts`), but
// nothing lowers it to the `own-property-keys` IR op the way `Object.keys`/
// `getOwnPropertyNames` do, so it falls back to an ordinary host-invocation
// call this backend has no row for at all (`host-invocation:
// ObjectConstructor.getOwnPropertySymbols`). A real, separate gap -- not
// specific to declared symbol fields -- left for follow-up.

// delete drives the field to genuine absence.
delete p[keyA]
console.log('afterDelete=' + String(keyA in p) + ' val=' + String(readA(p)) + ' hasOwn=' + String(p.hasOwnProperty(keyA)))
//! expect: afterDelete=false val=undefined hasOwn=false

// ...and a later write restores it -- absent UNTIL written, not absent forever.
p[keyA] = 99
console.log('rewritten=' + String(keyA in p) + ' ' + readA(p))
//! expect: rewritten=true 99

// A dynamic (`any`) receiver over the SAME concrete instance must reach the
// declared field, not a shadow expando -- otherwise the static route and the
// dynamic route would silently disagree about one object's state.
const dyn: any = p
dyn[keyB] = 'viaDynamic'
console.log('dynamicWrite=' + readB(p) + ' ' + dyn[keyB])
//! expect: dynamicWrite=viaDynamic viaDynamic

p[keyB] = 'viaStatic'
console.log('staticWrite=' + dyn[keyB] + ' ' + readB(p))
//! expect: staticWrite=viaStatic viaStatic

// A record (plain object literal), not a class, declaring the same kind of
// symbol-keyed field: the dispatcher this file exercises is per-struct, and a
// record is a struct too.
const rec = { [keyA]: 7, label: 'rec' }
console.log('rec=' + rec[keyA] + ' ' + String(keyA in rec) + ' ' + rec.label)
//! expect: rec=7 true rec

// An exported symbol, used as a computed field key from ANOTHER module
// (`_symbol-key-declared-field-shared.ts`) and from this one: both must
// resolve to the one declared field the symbol's own cell registered.
const holder = new Holder()
console.log('sharedConstructed=' + String(sharedKey in holder) + ' ' + String(readShared(holder)))
//! expect: sharedConstructed=true undefined

writeShared(holder, 42)
console.log('sharedAfterOtherModuleWrite=' + String(sharedKey in holder) + ' ' + readShared(holder))
//! expect: sharedAfterOtherModuleWrite=true 42

holder[sharedKey] = 43
console.log('sharedAfterThisModuleWrite=' + readShared(holder))
//! expect: sharedAfterThisModuleWrite=43
