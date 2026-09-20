//! expect: built

// hono's `FetchEventLike` (`types.ts`): an ABSTRACT class declaring only
// abstract members, which NOTHING in the program extends and nothing ever
// constructs -- it exists to type the service-worker event `hono-base.ts`'s
// `fire` reads `respondWith` off. The family has no overrides, so the virtual
// dispatch branch does not apply, and the abstract declaration owns no body to
// take a function object of either. No instance of it can exist, so the read
// is unreachable; what it must not be is a refusal that stops the whole
// program from emitting.

abstract class EventLike {
  abstract respondWith(answer: string): void
}

class Holder {
  event?: EventLike
}

const holder = new Holder()
const never = Number('0') === 1
if (never && holder.event) holder.event.respondWith('ok')
console.log('built')
