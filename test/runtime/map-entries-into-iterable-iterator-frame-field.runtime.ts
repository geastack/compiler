// A binary-document serializer keeps a Map's entry cursor in a frame record:
// `mapIterator: (sourceObject as Map<unknown, unknown>).entries()` stored in
// a field typed `IterableIterator<[unknown, unknown]> | null`, then stepped
// with `.next()` one entry per loop turn. The field holds the map's own
// cursor, so an entry added before the walk reaches it is still visited. The
// Map itself was recovered from an `unknown` by a brand check.
interface Frame {
  label: string
  mapIterator: IterableIterator<[unknown, unknown]> | null
}
function isMap(d: unknown): d is Map<unknown, unknown> {
  return Object.prototype.toString.call(d) === '[object Map]'
}
function frameOf(label: string, source: Map<unknown, unknown> | null): Frame {
  if (source !== null) return { label, mapIterator: source.entries() }
  return { label, mapIterator: null }
}
function walk(frame: Frame): string {
  const out: string[] = []
  const iterator = frame.mapIterator
  if (iterator === null) return `${frame.label}: none`
  for (;;) {
    const step = iterator.next()
    if (step.done) break
    const [key, value] = step.value
    out.push(`${String(key)}=${String(value)}`)
  }
  return `${frame.label}: ${out.join(',')}`
}
const scores = new Map<string, number>()
scores.set('a', 1)
scores.set('b', 2)
const source: unknown = scores
const frame = frameOf('scores', isMap(source) ? source : null)
scores.set('c', 3)
console.log(walk(frame))
const plain: unknown = 5
console.log(walk(frameOf('plain', isMap(plain) ? plain : null)))

//! expect: scores: a=1,b=2,c=3
//! expect: plain: none
