//! expect: 0
//! expect: 1
//! expect: 2:open
//! expect: 2:open,closing

// FIXED by keying the declared-member census on the member's DECLARATION.
//
// `censusDeclaredMembers` (`structural-declarations.ts`) is what lets a literal
// laid out as a contextual DECLARED type supply a getter body for a member that
// declaration spells as ordinary data -- `typed-custom-iterator-close.ts`
// records the non-generic case. It was keyed on the declared member's
// `ts.Symbol`, and a generic declaration does not have ONE of those:
// `instantiateSymbol` mints a fresh transient symbol per instantiation of a
// member whose type could contain a type variable, and hands the original back
// when it provably could not. So `Init<Live>.raw` and `Init<T>.raw` are two
// symbol objects for one member, this walk recorded the getter under one of
// them, and `structural-parts.ts` asked with the other -- which put the
// allocation back on `producers/allocations.ts`'s refusal, "an object literal
// accessor whose allocated shape declares the member as ordinary data has
// nowhere to install its body; reading it would call an unset slot".
//
// hono's `WSContext<T>` is the shape this came from: `@hono/node-server` writes
// `new WSContext<WebSocketLike>({ ..., get readyState() { return ws.readyState },
// ... })` against `interface WSContextInit<T> { readyState: WSReadyState; ... }`.
// Both spellings are exercised here: `raw: T` names the type parameter (always
// instantiated), `readyState: number` cannot (instantiated or not, depending on
// what the checker had already resolved).

interface Init<T> {
  raw: T
  readyState: number
  send(data: string): void
}

class Live {
  state = 0
  log: string[] = []
}

class Socket<T> {
  #init: Init<T>

  constructor(init: Init<T>) {
    this.#init = init
  }

  get raw(): T {
    return this.#init.raw
  }

  get readyState(): number {
    return this.#init.readyState
  }

  send(data: string): void {
    this.#init.send(data)
  }
}

const live = new Live()
const socket = new Socket<Live>({
  get raw() {
    return live
  },
  get readyState() {
    return live.state
  },
  send(data) {
    live.log.push(data)
  }
})

// Read around every mutation of the backing object: a getter body that was
// never installed could not observe any of them.
console.log(socket.readyState)
live.state = 1
console.log(socket.readyState)

socket.raw.state = 2
socket.send('open')
console.log(`${socket.readyState}:${live.log.join(',')}`)

socket.raw.log.push('closing')
console.log(`${socket.readyState}:${live.log.join(',')}`)
