// A ring of value records written by index and filled by `push`, carrying the
// program's whole result through their members: `bench/comparison/fixtures/
// object_create.ts`. Every member is written from integer arithmetic, so the
// integer-storage census must narrow all three to `long long` -- an indexed
// store into the Array moves the whole record and `push` copies it whole,
// neither is a member the census cannot see written.
type Point = { x: number; y: number; z: number }

function run(iterations: number): number {
  const ring: Point[] = []
  for (let i = 0; i < 64; i++) ring.push({ x: 0, y: 0, z: 0 })
  let total = 0
  for (let i = 0; i < iterations; i++) {
    ring[i % ring.length] = { x: (i + total) % 100000, y: i * 2, z: i * 3 }
    const o = ring[(i * 31 + 7) % ring.length]!
    total = (total + o.x + o.y + o.z) % 1000000000
  }
  return total
}

console.log(run(200000))
