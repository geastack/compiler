//! expect: 10
type Transform = (value: Leaf) => number

class Leaf {
  constructor(readonly value: number) {}
}

class FixedBundle {
  readonly items: Leaf[]
  readonly lookup: Map<string, Leaf>
  readonly transform: Transform

  constructor(seed: number) {
    const leaf = new Leaf(seed)
    this.items = [leaf]
    const lookup = new Map<string, Leaf>()
    lookup.set('main', leaf)
    this.lookup = lookup
    this.transform = (item) => item.value + 1
  }
}

function run(): number {
  const bundle = new FixedBundle(3)
  const first = bundle.items[0]!
  const mapped = bundle.lookup.get('main')!
  return first.value + mapped.value + bundle.transform(first)
}

console.log(run())
