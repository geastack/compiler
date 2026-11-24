// A binary-document serializer steps a Map's entry cursor kept in a frame
// record (`IterableIterator<[unknown, unknown]>`) and reads the pair off the
// step as `next.value[0]` / `next.value[1]`. Elsewhere in the same program a
// socket reader hands out byte chunks through a hand-written async iterator
// whose results are `{ value: chunk, done: false }` with a `Uint8Array`
// chunk.
//
// Both results share the lib's return arm `IteratorReturnResult<any>`: the
// chunk literal is viewed live as either arm (its `done` is a boolean slot),
// and the narrowed Map step views that return arm as its yield arm. Composed,
// the step's `value` has a route reading the chunk literal's typed-array slot
// as an Array. That route is dead (`done` was false), and a byte container is
// never an Array, so it is an impossible read that throws -- not a missing
// receipt that refuses the whole program.
interface Doc {
  [key: string]: any
}
interface Frame {
  label: string
  mapIterator: IterableIterator<[unknown, unknown]> | null
  keys: string[] | null
  target: Doc
}
function isMap(d: unknown): d is Map<unknown, unknown> {
  return Object.prototype.toString.call(d) === '[object Map]'
}
function mapFrameOf(label: string, source: Doc): Frame | null {
  if (source instanceof Map || isMap(source))
    return { label, mapIterator: (source as Map<unknown, unknown>).entries(), keys: null, target: source }
  return null
}
function plainFrameOf(label: string, source: Doc): Frame {
  return { label, mapIterator: null, keys: Object.keys(source), target: source }
}
function walk(frame: Frame): string {
  const out: string[] = []
  let index = 0
  for (;;) {
    let key: string
    let value: any
    if (frame.mapIterator !== null) {
      const next = frame.mapIterator.next()
      if (next.done) break
      key = next.value[0] as string
      value = next.value[1]
    } else {
      if (frame.keys === null || index >= frame.keys.length) break
      key = frame.keys[index++]!
      value = frame.target[key]
    }
    out.push(`${key}=${String(value)}`)
  }
  return `${frame.label}: ${out.join(',')}`
}

function chunks(source: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  let at = 0
  const iterator: AsyncGenerator<Uint8Array> = {
    next() {
      const value = source[at++]
      if (value != null) return Promise.resolve({ value, done: false })
      return Promise.resolve({ value: undefined, done: true })
    },
    return() {
      return Promise.resolve({ value: undefined, done: true })
    },
    throw(err: Error) {
      return Promise.reject(err)
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }
  return iterator
}

const scores = new Map<string, number>()
scores.set('a', 1)
scores.set('b', 2)
const scoresDoc: Doc = scores
const mapFrame = mapFrameOf('scores', scoresDoc)
if (mapFrame !== null) console.log(walk(mapFrame))
console.log(walk(plainFrameOf('plain', { x: 1, y: 'two' })))

const run = async (): Promise<void> => {
  let total = 0
  for await (const chunk of chunks([new Uint8Array([1, 2]), new Uint8Array([3])])) total += chunk.length
  console.log(`bytes=${total}`)
}
void run()

//! expect: scores: a=1,b=2
//! expect: plain: x=1,y=two
//! expect: bytes=3
