// A GENERIC CLASS THAT EXTENDS ANOTHER AND WRITES ITS OWN CONSTRUCTOR.
//
// `runtime/node/globals.ts`'s `class MessageEvent<T = any> extends Event`
// writes `constructor(type, init = {}) { super(type); this.data = init.data }`.
// Its three non-generic siblings -- `CloseEventImpl`, `ErrorEventImpl`, and
// @hono/node-server's own two -- all got that body; the generic one was
// constructed as though it had written NO constructor, which is two wrong
// answers at once: `data` is never assigned, and the implicit `super(...args)`
// forwards the DERIVED signature's own second parameter (a `MessageEventInit`)
// into the base's (an `EventInit`), two different record shapes, which is the
// clang error the emitted unit stopped on.

interface Init {
  bubbles?: boolean
}

class Base {
  readonly type: string
  constructor(type: string, _init?: Init) {
    this.type = type
  }
}

interface Payload<T = any> {
  data?: T
}

class Carrier<T = any> extends Base {
  readonly data: T
  constructor(type: string, init: Payload<T> = {}) {
    super(type)
    this.data = init.data as T
  }
}

type Kind = 'payload' | 'other'

const carried: Carrier<Kind> = new Carrier<Kind>('message', { data: 'payload' })

//! expect: type=message data=payload
console.log('type=' + carried.type + ' data=' + carried.data)

// A SECOND copy of the same class, which is what `websocket.ts` reaches: the
// instance is constructed where the type argument is INFERRED and handed to a
// listener that spells it, so the census holds two copies whose layouts
// collapse onto one struct. Neither copy's body can be picked knowing only the
// generic root, which is how the class came to have no constructor at all.
const received = (event: Carrier<string>): string => event.data

//! expect: received=payload
console.log('received=' + received(carried))

// The non-generic sibling, for the contrast: the same heritage and the same
// two-parameter constructor, which always worked.
class Plain extends Base {
  readonly code: number
  constructor(type: string, code: number) {
    super(type)
    this.code = code
  }
}

const plain = new Plain('close', 1000)

//! expect: plain=close/1000
console.log('plain=' + plain.type + '/' + plain.code)
