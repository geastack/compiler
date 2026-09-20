// `this.engine && this.clip` -- a real app's guard-then-use idiom.
// The kept operand is a `class-ref(shared-refcount)`, the collapsed form of
// `Engine | null`, so the ONLY value it can hold on the branch where it tested
// falsy is its own null. The merge publishes an optional, which is where that
// null belongs; nothing needs converting.
//
// `Clip` is self-referential so the merge's own carrier is
// `optional(native-record-ref)` rather than a second collapsed reference --
// the exact pair the refusal named.
class Engine {
  constructor(readonly gain: number) {}
}

interface Clip {
  length: number
  next: Clip | null
}

class Player {
  engine: Engine | null = null
  clip: Clip | null = null

  playable(): number {
    const found = this.engine && this.clip
    return found === null ? -1 : found.length
  }
}

const loaded = new Player()
loaded.engine = new Engine(1)
loaded.clip = { length: 7, next: null }
const noClip = new Player()
noClip.engine = new Engine(1)
const noEngine = new Player()
noEngine.clip = { length: 7, next: null }
console.log(`${loaded.playable()},${noClip.playable()},${noEngine.playable()}`)
