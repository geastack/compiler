// CALLING A METHOD ONE ARM OF A UNION DOES NOT HAVE, AND DISCARDING THE
// RESULT.
//
// hono's `_getQueryParam` (`utils/url.ts`) writes
// `;(results[name] as string[]).push(value)` where the read carries
// `string | string[]`: the `as` names the arm the author means, and the string
// arm is proved to have no `push`, so 13.3.6.1 throws if it is ever the live
// one. That is the same per-arm dispatch `union-member-absent-on-promise-arm`
// covers for a READ, one step later.
//
// The difference the discarded result makes is physical: the absent arm's
// throw is instantiated at `void` -- there is no result cell for it to be
// instantiated at -- while `Array.prototype.push` still evaluates to a length,
// and C++'s conditional operator has no common type for `void` and `double`.
// Both sides are discarded explicitly, which is what the statement already
// means.

const append = (slot: string | string[], value: string): void => {
  ;(slot as string[]).push(value)
}

const collected: string[] = []
append(collected, 'first')
append(collected, 'second')

//! expect: collected=first,second
console.log('collected=' + collected.join(','))

// The same call with its result READ still instantiates the throw at the
// result's own carrier, which is the path that already worked.
const appendCounted = (slot: string | string[], value: string): number => (slot as string[]).push(value)

//! expect: length=3
console.log('length=' + appendCounted(collected, 'third'))

// And the live-arm throw really is reachable: a string arm has no `push`.
const refused = (): string => {
  try {
    append('not an array', 'x')
    return 'no throw'
  } catch (error: unknown) {
    return error instanceof TypeError ? 'TypeError' : 'other'
  }
}

//! expect: string-arm=TypeError
console.log('string-arm=' + refused())
