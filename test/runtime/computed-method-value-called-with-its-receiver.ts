// A CLASS METHOD READ THROUGH A RUNTIME KEY, CAST TO A RECEIVER-LESS FUNCTION
// TYPE, AND CALLED.
//
// `raw[key]()` where `key` is a generic over a literal union is an HTTP
// framework's `AppRequest.#cachedBody` exactly: the reader is selected at run time and
// the read is cast to `() => Promise<Body[Key]>`, a function type that
// declares no `this` because no TypeScript method type ever does.
//
// The getter publishes the selected Function without capturing the object.
// The immediate member call supplies its logical receiver through the native
// method entry, while own-property overrides keep the same published carrier.

type Body = {
  text: string
  size: number
}

class Reader {
  readonly payload: string

  constructor(payload: string) {
    this.payload = payload
  }

  text(): Promise<string> {
    return Promise.resolve(this.payload)
  }

  size(): Promise<number> {
    return Promise.resolve(this.payload.length)
  }
}

const reader = new Reader('payload')

// The cast is the whole point: every call site passes a literal, so each
// instantiation resolves `Body[Key]` to one payload, and the read is stated as
// the receiver-less callable the language sees.
const read = <Key extends keyof Body>(key: Key): Promise<Body[Key]> => (reader[key] as () => Promise<Body[Key]>)()

// Called by name as well, exactly as that framework's `AppRequest.text()` wraps the
// same reader `#cachedBody` selects at run time: a method reachable ONLY
// through the computed read is shaken before the class layout is projected,
// and the read then has no prototype arm to select at all.
//! expect: direct=payload/7
console.log('direct=' + (await reader.text()) + '/' + (await reader.size()))

//! expect: text=payload
console.log('text=' + (await read('text')))

//! expect: size=7
console.log('size=' + (await read('size')))
