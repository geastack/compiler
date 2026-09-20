// A structural record returned where a NAMED shape is declared.
//
// The mirror of `record-structural-return.ts`, one carrier kind out. An
// anonymous object type derives the structural `record` carrier, which holds
// its own field list; a NAMED one -- an interface or a type alias -- derives
// `native-record-ref`, which holds a shape id and nothing else so a recursive
// interface stays finite. Nothing could compare the two: `conversion/build.ts`
// filtered the pair out before `registry.recasting` was ever asked, because a
// carrier with no field list has nothing to compare against.
//
// The layout is resolvable -- `records.ts`'s `recordFieldsOfShape` is what
// builds every struct body from it -- so this is a lookup, not a capability.
// It reaches the registry as a policy for the reason `ClassHeritagePolicy`
// does: a layout is not carrier identity and would wrongly enter
// `representationKey`. `emit-callable.ts`'s `structuralRecordViewText` already
// performed exactly this rebuild for a class instance handed to an interface
// slot, so the emitter needed the source side widened and the return path
// wired to the same two-step an argument slot already takes.
interface Options {
  name: string
  retries?: number
  note?: string
}

const narrow = (source: { name: string; retries: number; extra: string }): Options => source

const options = narrow({ name: 'a', retries: 40, extra: 'dropped' })

let probe = options.retries ?? 0
if (options.note !== undefined) probe += 1000
if (options.name !== 'a') probe += 100

export const result = probe

if (probe !== 40) throw new Error('record into a named layout computed the wrong result')
