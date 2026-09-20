// A PER-KEY PROMISE CACHE READ AND WRITTEN THROUGH A GENERIC KEY.
//
// hono's `HonoRequest` caches each body reader's promise in one record keyed
// by the reader's name, and declared that record `Partial<Body>` where `Body`
// maps the key to the AWAITED payload -- `size: number`, not
// `Promise<number>`. The code stores the promise and never awaits on the way
// in, so the declaration was false, and the emitter was right to refuse the
// write: the only conversion that would have fit is an implicit await, which
// is a different program. TypeScript accepted it because the sibling `json`
// arm is `any`, `Body[keyof Body]` therefore contains `any`, and one `any` arm
// erases a whole union.
//
// Declared as what it holds -- a mapped type of promises -- and read through
// one generic whose every call site passes a literal key, each reader gets its
// own payload back: `text()` a string, `size()` a number. The `any` arm
// survives because the library really does cache a parsed body under it; it
// only widens `Body[Key]` while `Key` is still a parameter, and every
// instantiation resolves to a single key.

type Body = {
  json: any
  text: string
  size: number
}

type BodyCache = { [Key in keyof Body]?: Promise<Body[Key]> }

type Readers = { [Key in keyof Body]: () => Promise<Body[Key]> }

const sources: Readers = {
  json: (): Promise<unknown> => Promise.resolve('parsed'),
  text: (): Promise<string> => Promise.resolve('payload'),
  size: (): Promise<number> => Promise.resolve(7)
}

let fills = 0

const cache: BodyCache = {}

const cached = <Key extends keyof Body>(key: Key): Promise<Body[Key]> => {
  const hit = cache[key]
  if (hit) {
    return hit
  }
  fills = fills + 1
  return (cache[key] = sources[key]())
}

// Each instantiation keeps the key's own payload type -- `text` is a string
// here, not the union of every arm -- so `.length` below is a string read.
const text = async (): Promise<string> => cached('text')
const size = async (): Promise<number> => cached('size')

//! expect: text=payload len=7
const first = await text()
console.log('text=' + first + ' len=' + first.length)

//! expect: size=7
console.log('size=' + (await size()))

// A second read of the same key is the cached promise, not a second fill.
//! expect: again=payload fills=2
console.log('again=' + (await text()) + ' fills=' + fills)
