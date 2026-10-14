//! expect: top ranges 6
//! expect: range 0-1 anchor 0.5 0.25 -1 distance 1.3463 lods 0--
//! expect: range 1-2 anchor 3.5 0.25 -3 distance 4.6704 lods 01-
//! expect: range 2-3 anchor 6.5 0.25 -5 distance 8.2348 lods -1-
//! expect: range 3-4 anchor 9.5 0.25 -7 distance 11.8242 lods -1-
//! expect: range 4-5 anchor 12.5 0.25 -9 distance 15.4212 lods --2
//! expect: range 5-6 anchor 15.5 0.25 -11 distance 19.0214 lods --2
//! expect: local ranges 6 last 5-6
// A game's instance-culling pass (its `lod` path) without three: a
// generator that yields inside nested loops and pushes one anchored range per
// group into its caller's array, run to completion by an empty-bodied
// `while (!work.next().done) {}`. That loop ran its test once, so the caller
// saw no ranges at all and every LOD band was culled.
class Vec3 {
  x = 0
  y = 0
  z = 0
  setFromMatrixPosition(m: Mat4): Vec3 {
    const e = m.elements
    this.x = e[12]!
    this.y = e[13]!
    this.z = e[14]!
    return this
  }
}
class Mat4 {
  elements: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  fromArray(a: number[], o: number): Mat4 {
    for (let i = 0; i < 16; i++) this.elements[i] = a[o + i]!
    return this
  }
}
type AnchorRange = { start: number; end: number; anchor: Vec3 }
const source: number[] = []
for (let i = 0; i < 6; i++) source.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 3 + 0.5, 0.25, -i * 2 - 1, 1)

function* prepare(lod: boolean, out: AnchorRange[]): Generator<void, void, void> {
  const groups = new Map<string, number[]>()
  const matrix = new Mat4()
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0) yield
    matrix.fromArray(source, i * 16)
    const key = lod ? String(i) : `${Math.floor(matrix.elements[12]!)}`
    const group = groups.get(key) ?? []
    group.push(i)
    groups.set(key, group)
  }
  let index = 0
  for (const indices of groups.values()) {
    const start = index
    for (const i of indices) {
      if (index % 2 === 0) yield
      matrix.fromArray(source, i * 16)
      index++
    }
    out.push({ start, end: index, anchor: new Vec3().setFromMatrixPosition(matrix) })
  }
}

const ranges: AnchorRange[] = []
const work = prepare(true, ranges)
while (!work.next().done) {
  /* run to completion */
}
console.log(`top ranges ${ranges.length}`)
const eye = [0, 1, 0]
for (const r of ranges) {
  const dx = eye[0]! - r.anchor.x
  const dy = eye[1]! - r.anchor.y
  const dz = eye[2]! - r.anchor.z
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const bands = [d < 0 || d >= 5.5 ? '-' : '0', d < 4.5 || d >= 14.5 ? '-' : '1', d < 13.5 ? '-' : '2'].join('')
  console.log(`range ${r.start}-${r.end} anchor ${r.anchor.x} ${r.anchor.y} ${r.anchor.z} distance ${d.toFixed(4)} lods ${bands}`)
}

function prepareLocally(): string {
  const local: AnchorRange[] = []
  const job = prepare(true, local)
  while (!job.next().done) {}
  const last = local[local.length - 1]
  return `${local.length} last ${last?.start}-${last?.end}`
}
console.log(`local ranges ${prepareLocally()}`)
