// A record returned where a narrower record shape is declared.
//
// `recordsRecastable` used to demand the two shapes declare exactly the same
// fields with exactly the same requiredness, which is shape EQUALITY -- not the
// relation TypeScript admits at a return. `return options` out of a method
// declared to return an overlapping subset is ordinary TypeScript, and the
// mongodb driver is built out of it: every `CommandOptions` producer hands a
// record of dozens of fields to a slot declaring a differently ordered,
// differently optional subset, which is 16 of the probe's unmet obligations
// under one predicate.
//
// Three separate widenings meet here, and each is a physical no-op or a single
// constructor call rather than a new capability:
//   - `tag` is DROPPED. The declared type is what every later read goes
//     through, so the rebuild loses nothing the program could still see.
//   - `age: number` fills `age?: number | undefined` -- requiredness may widen
//     because there is no physical presence bit (`records.ts` stores exactly
//     `cppTypeOf(field.value)`), so `in` reads the carrier's own flag, which
//     this sets. Narrowing it would turn that flag into a constant `true`.
//   - `note` is absent from the source entirely, so it takes
//     `gea::Optional<...>{}` -- admitted only because that carrier HAS an
//     absent value; a missing field over a bare `T` is still a hole.
// Both sides are anonymous object types on purpose: a NAMED declaration --
// interface or type alias -- derives `native-record-ref` (a nominal layout
// resolved by shape id at emission, `derive.ts`'s `declared` case), and only an
// anonymous one derives the structural `record` this recast is written for.
const widen = (source: { name: string; age: number; tag: string }): { name: string; age?: number; note?: string } => source

const narrow = widen({ name: 'a', age: 40, tag: 'x' })

let probe = narrow.age ?? 0
if (narrow.note !== undefined) probe += 1000
if (narrow.name !== 'a') probe += 100
if (!('age' in narrow)) probe += 10000

export const result = probe

if (probe !== 40) throw new Error('structural record return computed the wrong result')
