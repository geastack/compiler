//! expect: chain=6
//! expect: loop=1
//! expect: rebound=2
//! emitted-once: -> std::false_type
// A class whose reference fields are written only by its constructor, and
// only with the constructor's own arguments, can only ever point at objects
// that existed before it: no cycle can run through it, so the cycle collector
// need not trace it (`records.ts`'s `olderOnly`). Exactly one class here
// qualifies. `Loop` stores `this` into its own field, and `Rebound` has a field
// a method rewrites after construction -- both can close a cycle, and both
// must stay traced.

class Chain {
  constructor(
    readonly next: Chain | null,
    readonly value: number
  ) {}
}

class Loop {
  next: Loop | null = null
  constructor() {
    this.next = this
  }
}

class Rebound {
  constructor(public other: Rebound | null) {}
  point(at: Rebound): void {
    this.other = at
  }
}

let chain: Chain | null = null
for (let index = 1; index <= 6; index++) chain = new Chain(chain, index)
let links = 0
for (let at = chain; at !== null; at = at.next) links++
console.log(`chain=${links}`)

const loop = new Loop()
console.log(`loop=${loop.next === loop ? 1 : 0}`)

const first = new Rebound(null)
const second = new Rebound(first)
first.point(second)
console.log(`rebound=${first.other === second && second.other === first ? 2 : 0}`)
