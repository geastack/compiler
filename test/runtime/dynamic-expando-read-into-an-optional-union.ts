//! expect: true
//! expect: 2
//! expect: bad

// A symbol-keyed expando cached on an object the program reaches through a
// widened view, holding `Uint8Array | Error` and read back as
// `Uint8Array | Error | undefined` -- `@hono/node-server`'s own
// `readBodyBufferedBeforeDisconnect`, which caches the recovered body or the
// error that replaced it on the incoming message.
//
// The absence is the OPTIONAL's (the key is simply not there yet); the payload
// is decoded arm by arm on tag and payload type, so a value matching no arm
// refuses at run time rather than reinterpreting one arm as another.
const cacheKey = Symbol('cached')

class Incoming {
  constructor(readonly id: number) {}
}

type WithCache = Incoming & { [cacheKey]?: Uint8Array | Error }

const cached = (incoming: Incoming): Uint8Array | Error | undefined => (incoming as WithCache)[cacheKey]

const store = (incoming: Incoming, value: Uint8Array | Error): void => {
  ;(incoming as WithCache)[cacheKey] = value
}

const one = new Incoming(1)
console.log(cached(one) === undefined)
store(one, new Uint8Array([1, 2]))
const back = cached(one)
console.log(back instanceof Uint8Array ? back.length : 'other')
store(one, new Error('bad'))
const again = cached(one)
console.log(again instanceof Error ? again.message : 'other')
