// A `T | absent` carrier read out of a genuinely dynamic value used to lose
// its own absent arm on the way in.
//
// `asNullable`/`asMaybe` return `value: any` under a declared `string | null`/
// `string | undefined`, so the emitted ABI result is correctly
// `gea::Optional<std::string>` -- but the RETURN STATEMENT's own conversion
// (`convertedValueText`, `targets/cpp/emit-narrowing.ts`) used to see a
// `dynamic` source and an `optional` target and unconditionally convert the
// dynamic value into the bare PAYLOAD (`dynamic -> string`, a real, installed
// recipe) rather than ask whether the box was empty first. A payload unbox is
// an ASSERTION ("this box holds a string"), so a box that actually held
// `Null`/`Undefined` aborted at runtime with "an assertion out of a dynamic
// value" -- certified, clang-clean, and wrong. Fixed by installing
// `optionalAbsenceTag`/`unboxedLoadText`'s own `optional` branch (the tag
// check the ABI needed all along) and by making the dynamic-source case defer
// to that branch instead of the payload-only conversion.
//
// The disagreeing write below (`string`/`undefined` then, unreachably, a
// `number`) exists only to keep each parameter's own census binding refused
// -- so `value` stays genuinely `gea::Value` at the return, exercising the
// dynamic-source path this fixture is for, rather than a census-narrowed
// concrete carrier that would never have hit the bug.
//
// The three reads below are taken BEFORE the guards that follow: a guard of
// the shape `if (x !== null) throw` narrows a LATER read of `x` to bare
// `null` by ordinary control-flow narrowing, which asks this compiler for a
// different, currently-unsupported primitive (narrowing an `Optional` down to
// its own bare absence value) that has nothing to do with the defect this
// fixture checks. Reading each value into the template first keeps this
// fixture on the one question it exists to answer.
const asNullable = (value: any): string | null => value
const asMaybe = (value: any): string | undefined => value

let nullSlot: unknown = null
for (let i = 0; i < 0; i++) nullSlot = 2
const absentNull = asNullable(nullSlot)

let undefinedSlot: unknown = undefined
for (let i = 0; i < 0; i++) undefinedSlot = 2
const absentUndefined = asMaybe(undefinedSlot)

let presentSlot: unknown = 'hi'
for (let i = 0; i < 0; i++) presentSlot = 2
const present = asNullable(presentSlot)

export const result = `${absentNull}/${absentUndefined}/${present}`

if (result !== 'null/undefined/hi')
  throw new Error('a dynamic absent/present value did not round-trip through its declared optional carrier')
