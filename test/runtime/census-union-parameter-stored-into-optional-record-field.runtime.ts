// A geometry builder's `card(c)` keeps its centre in a `Point | null` field
// while it emits vertices. Callers pass both a plain `{ x, y, z }` and a
// vector class instance, so `c` holds a census-built `record | class` union.
// The store into the optional record field selected the record arm without
// testing it, and a live class arm was read through the record's layout.
// Each arm enters the field through its own conversion instead.
class CardCentre {
  label = 'centre'
  weight = 99
  x: number
  y: number
  z: number
  constructor(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
  }
}

interface Point {
  x: number
  y: number
  z: number
}

class LeafCardBuilder {
  centres: number[] = []
  current: Point | null = null
  vert(p: Point): void {
    const q = this.current || p
    this.centres.push(q.x, q.y, q.z)
  }
  card(c: Point): void {
    this.current = c
    this.vert({ x: c.x + 1, y: c.y, z: c.z })
    this.current = null
  }
}

const builder = new LeafCardBuilder()
builder.card({ x: 1, y: 2, z: 3 })
builder.card(new CardCentre(4, 5, 6))
builder.vert(new CardCentre(7, 8, 9))
console.log(builder.centres.join(','))
//! expect: 1,2,3,4,5,6,7,8,9
