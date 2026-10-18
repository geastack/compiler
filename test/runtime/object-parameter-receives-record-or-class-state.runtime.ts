// One `state: ViewState` parameter receives both a plain record and a class
// instance whose fields satisfy the same shape, and forwards it to a helper
// typed `state: object` that only uses it as a WeakMap key. Both callers'
// values must reach the key with their identity intact: the plain record
// finds its own generation, the class instance its own, and an unclaimed
// object finds none.
//! expect: plain {"tag":"a","generation":1,"revision":1}
// Node prints `live {"tag":"b","generation":2,"revision":3}`. Natively the
// class instance passed as `ViewState` is rebuilt into a fresh record struct
// (record views copy, conversion/record-view.ts), so the WeakMap lookup misses.
//! known-wrong: live {"tag":"b","generation":null,"revision":3} -- class instance viewed as a record is a copy; identity lost
//! expect: fresh {"tag":"c","generation":null,"revision":-1}
//! expect: retired {"tag":"b","generation":null,"revision":3}
export {}

class Session {
  mode = 'live'
  revision = 3
}

type ViewState = { revision?: number; mode?: string }

const owners = new WeakMap<object, number>()
let next = 0

function claim(state: object): number {
  const generation = ++next
  owners.set(state, generation)
  return generation
}

function release(state: object): void {
  owners.delete(state)
}

function generationOf(state: object, tag: string): number | null {
  const generation = owners.get(state)
  return generation !== undefined && tag.length > 0 ? generation : null
}

function contextOf(state: ViewState, tag: string) {
  return { tag, generation: generationOf(state, tag), revision: state.revision ?? -1 }
}

const plain: ViewState = { revision: 1 }
const live = new Session()
claim(plain)
claim(live)
console.log('plain', JSON.stringify(contextOf(plain, 'a')))
console.log('live', JSON.stringify(contextOf(live, 'b')))
console.log('fresh', JSON.stringify(contextOf({}, 'c')))
release(live)
console.log('retired', JSON.stringify(contextOf(live, 'b')))
