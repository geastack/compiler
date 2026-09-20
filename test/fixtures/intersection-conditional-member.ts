// An intersection one of whose members is a CONDITIONAL type alias.
//
// `structural-declared-body.ts` interns a conditional alias with no body at
// all: it is not a record shape, and it is not any other shape the deriver can
// walk either. The intersection deriver used to demand a record of every member
// before it would read the checker's own reconciliation -- which asks the wrong
// member the wrong question, because that branch reads no member at all, only
// the reconciled type. mongodb's `WithId<T> = EnhancedOmit<T, '_id'> & { _id:
// InferIdType<T> }` is the shape, and it is a member of nearly every collection
// type the driver declares.
//
// What still outranks the reconciliation is a member carrying its own answer --
// a nominal class, a primitive value, a signature, a type parameter -- and each
// of those has its own branch above it. A conditional alias has none, so the
// checker's answer is both the only one available and the right one.

type EnhancedOmit<TRecord, KeyUnion> = string extends keyof TRecord
  ? TRecord
  : TRecord extends unknown
    ? Pick<TRecord, Exclude<keyof TRecord, KeyUnion>>
    : never

interface Todo {
  id: number
  title: string
  done: boolean
}

// `EnhancedOmit<Todo, 'id'>` has no body of its own; the intersection does.
type WithId<TRecord> = EnhancedOmit<TRecord, 'id'> & { id: number }

const stored: WithId<Todo> = { id: 7, title: 'write the fixture', done: false }

const titleLength = (row: WithId<Todo>): number => row.title.length

export const probe = stored.id + titleLength(stored) + (stored.done ? 1 : 0)
