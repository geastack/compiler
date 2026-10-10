// node-server `websocket.ts`'s module body -- `export const CloseEvent: typeof
// globalThis.CloseEvent = globalThis.CloseEvent ?? class extends Event {...}`,
// and the same line again for ErrorEvent. The fallback is a SECOND program
// class, unrelated to the one the global holds, and no conversion between two
// nominal constructor families exists or should.
//
// None is needed after proving the program's own installation below. Every
// observation of the global property goes through that one typed cell, the
// unconditional store dominates its reads, and the global object never
// escapes. The cell therefore retains the nominal native constructor without
// boxing it into an open dictionary. Its read has no absent state, so `??`
// never evaluates its right arm. The ambient declaration alone proves none
// of this; an escaping or conditionally installed property stays open.
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
