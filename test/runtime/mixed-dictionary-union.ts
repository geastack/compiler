// Adding scalar and array alternatives must not change the dictionary's
// storage: all views below still refer to the original mutable object.
//
// FIXED by dispatching the READ per arm. `entry(table, "first") as string[]`
// keeps the whole union as its carrier, so the `join` access is asked to find
// the member on every arm at once. It is now recorded as one claim PER ARM
// (`mixedUnionClaimOf`): each arm that answers keeps its own read, settled by
// the same ladder a lone receiver of that carrier would use, and the call
// fusion spells `is<N>() ? ... : ...` over them. An arm that PROVABLY holds no
// callable of that name -- a `string` with no `String.prototype.join`, a
// `Record<string, string | string[]>` whose values are not callable whatever
// key is present -- renders the TypeError JavaScript throws one step later.
// An arm this cannot prove refuses the whole claim, so "not implemented here"
// never masquerades as "the language answers undefined".
//
// MEASURED DEAD END, do not retry: honouring the cast so it narrows the CARRIER
// (plus a `require-tagged-union-arm` guard, so the claim is checked rather than
// a `reinterpret_cast`) makes this program print all seven lines -- and breaks
// `native-indexed-union.ts`, whose `label('plain')` passes a `string` to
// `(value as { label?: string }).label`. That assertion is FALSE at runtime, and
// JavaScript's answer is a harmless `undefined`; narrowing the carrier turns it
// into an abort. No static fact separates the two cases: in both, an `as` names
// one arm and the member is absent from another, and the checker honours the
// assertion in both. So the assertion cannot be the authority; the dispatching
// read is.
type Tables = Record<string, string> | Record<string, string[]>
type QueryResult = string | string[] | Tables | undefined

function query(table: Tables, key?: string): QueryResult {
  return key ? table[key] : table
}

function identity(value: QueryResult): QueryResult {
  return value
}

// `!`, not a widened return type: every caller below passes a key it has just
// written, so the claim this function makes is that the entry is present.
// Under `noUncheckedIndexedAccess` (this project's own setting) `table[key]`
// is `string | string[] | undefined`, and returning it against the declared
// `string | string[]` was a real TS2322 that withheld the certificate and
// stopped the program running at all.
function entry(table: Tables, key: string): string | string[] {
  return table[key]!
}

const table: Tables = {}
table.first = 'before'
const alias = query(table) as Tables
alias.first = ['after', 'change']
//! expect: original=after,change
console.log('original=' + (entry(table, 'first') as string[]).join(','))
table.second = 'shared'
//! expect: alias=true
console.log('alias=' + (alias.second === 'shared'))
//! expect: item=after,change
console.log('item=' + (query(table, 'first') as string[]).join(','))
//! expect: scalar=true
console.log('scalar=' + (identity('plain') === 'plain'))
//! expect: array=a,b
console.log('array=' + (identity(['a', 'b']) as string[]).join(','))
//! expect: absent=true
console.log('absent=' + (identity(undefined) === undefined))

//! expect: equality=true/true/false/true
console.log(
  'equality=' +
    ('plain' === identity('plain')) +
    '/' +
    (identity('other') !== 'plain') +
    '/' +
    (identity(undefined) === 'plain') +
    '/' +
    (identity(undefined) !== 'plain')
)
