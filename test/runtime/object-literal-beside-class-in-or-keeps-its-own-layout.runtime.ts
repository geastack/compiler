// `sd || { maxWireVersion }` -- a database client's `Topology.lastHello` -- types the
// literal contextually by the left operand's class, but the literal is not
// that class: it lacks the class's required fields and methods. It keeps its
// own layout and the merge holds either.
class Description {
  constructor(
    readonly address: string,
    readonly maxWireVersion: number
  ) {}
  describe(): string {
    return `${this.address}@${this.maxWireVersion}`
  }
}
const pick = (descriptions: Description[]): { maxWireVersion: number } => {
  const found = descriptions.filter((d) => d.maxWireVersion > 5)[0]
  const result = found || { maxWireVersion: 0 }
  return result
}
console.log(pick([new Description('a', 3), new Description('b', 9)]).maxWireVersion)
console.log(pick([new Description('a', 3)]).maxWireVersion)
// The same merge read back as a Document, the way `lastHello(): Document` returns it.
const lastHello = (descriptions: Description[]): { [key: string]: any } => {
  const sd = descriptions.filter((d) => d.maxWireVersion > 5)[0]
  const result = sd || { maxWireVersion: 1 }
  return result
}
console.log(lastHello([]).maxWireVersion, lastHello([new Description('c', 8)]).address)

//! expect: 9
//! expect: 0
//! expect: 1 c
