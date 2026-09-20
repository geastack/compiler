// node-server `websocket.ts`'s module body -- `export const CloseEvent: typeof
// globalThis.CloseEvent = globalThis.CloseEvent ?? class extends Event {...}`,
// and the same line again for ErrorEvent. The fallback is a SECOND program
// class, unrelated to the one the global holds, and no conversion between two
// nominal constructor families exists or should.
//
// None is needed: the plan gives the global read a bare `constructor-family`,
// which is the census's own statement that the value is there -- a host that
// says otherwise says so through `absent-globals.ts`, which types the read
// `undefined` instead. A carrier with no absent state is never nullish, so
// `??` never evaluates its right arm.
class BaseThing {
  tag: string

  constructor(tag: string) {
    this.tag = tag
  }
}

declare var Thing: typeof BaseThing

globalThis.Thing = BaseThing

const Chosen: typeof BaseThing =
  globalThis.Thing ??
  class {
    tag: string
    constructor(_tag: string) {
      this.tag = 'fallback'
    }
  }

// `fallback` here would mean the dead arm ran after all.
console.log(new Chosen('kept').tag)
//! expect: kept
