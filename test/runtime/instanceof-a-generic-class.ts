//! expect: stream
//! expect: text

// `v instanceof C` names the class OBJECT, and a class object is not a cell
// here: the test is the hierarchy census's recipe over the LEFT operand's own
// carrier, so the right operand renders nothing at all. Coverage for the
// carrier shapes that recipe runs over -- a generic class as one arm of a
// union -- alongside the read that publishes the class object. The case that
// has no cell to read (a generic the program never instantiates, which the
// census does not walk) needs a whole module graph to arise and is covered by
// the node-compat hono build, not reproducible in one file here.
class Chunks<R = number> {
  constructor(readonly items: readonly R[]) {}
}

type Payload = string | Chunks<number>

const describe = (body: Payload): string => (body instanceof Chunks ? 'stream' : 'text')

console.log(describe(new Chunks<number>([1, 2])))
console.log(describe('hello'))
