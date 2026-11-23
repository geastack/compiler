//! expect: ray hit 2 at 3
//! expect: ground 4
//! expect: none 0
//! expect: rewritten 1 then 5
//! expect: grown 3 seen 3
//! expect: kept 2
//! expect: swapped 3 then 9
//! emitted-has: = &((GEA_LIKELY(gea_dense_ok_
//! emitted-has: = ((GEA_LIKELY(gea_dense_ok_
// A loop over a dense window that changes no array reads each element
// through a pointer to its cell instead of retaining a copy into the binding:
// a collision world's raycast and groundHeight paid a retain and a release
// per box for `const box = boxes[i]`, the largest piece of a game's enemy
// update. A windowed loop that stores into the array keeps copying (the
// second `emitted-has`), a loop that calls code that grows it takes no window,
// and a box kept past the loop stays its own.

class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number
  ) {}
}

interface Box {
  min: Vec3
  max: Vec3
  id: number
  solid: boolean
}

const makeWorld = () => {
  const boxes: Box[] = []
  return {
    add(id: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, solid: boolean): void {
      boxes.push({ min: new Vec3(x0, y0, z0), max: new Vec3(x1, y1, z1), id, solid })
    },
    raycast(ox: number, oy: number, oz: number, dx: number): number {
      let nearest = 1000
      let hit: Box | null = null
      const inv = 1 / dx
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        if (!box.solid) continue
        if (oy < box.min.y || oy > box.max.y || oz < box.min.z || oz > box.max.z) continue
        const t = (box.min.x - ox) * inv
        if (t > 0 && t < nearest) {
          nearest = t
          hit = box
        }
      }
      return hit === null ? 0 : hit.id * 1000 + nearest
    },
    nearest(x: number): Box | null {
      let best: Box | null = null
      let gap = 1000
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        if (box.min.x > x && box.min.x - x < gap) {
          gap = box.min.x - x
          best = box
        }
      }
      return best
    },
    groundHeight(x: number, z: number): number {
      let height = 0
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z && box.max.y > height) height = box.max.y
      }
      return height
    },
    // Stores into the array it walks: the element a binding read can be
    // replaced (and released) under it, so it keeps its own copy.
    rewrite(): string {
      let first = 0
      let after = 0
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        boxes[i] = { min: box.min, max: box.max, id: box.id + 4, solid: box.solid }
        if (i === 0) {
          first = box.id
          after = boxes[i].id
        }
      }
      return first + ' then ' + after
    },
    // Calls code that grows the array.
    visit(grow: () => void): number {
      let seen = 0
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        if (box.id > 0) grow()
        seen++
      }
      return seen
    },
    count(): number {
      return boxes.length
    }
  }
}

const world = makeWorld()
world.add(1, 5, 0, 0, 6, 2, 2, true)
world.add(2, 3, 0, 0, 4, 4, 2, true)
world.add(3, 1, 0, 0, 2, 2, 2, false)
const ray = world.raycast(0, 1, 1, 1)
console.log('ray hit ' + Math.floor(ray / 1000) + ' at ' + (ray % 1000))
console.log('ground ' + world.groundHeight(3.5, 1))
console.log('none ' + world.groundHeight(-10, 1))

const rewriting = makeWorld()
rewriting.add(1, 0, 0, 0, 1, 1, 1, true)
console.log('rewritten ' + rewriting.rewrite())

const growing = makeWorld()
growing.add(1, 0, 0, 0, 1, 1, 1, true)
let grows = 0
const seen = growing.visit(() => {
  if (grows < 2) {
    grows++
    growing.add(9, 0, 0, 0, 1, 1, 1, true)
  }
})
console.log('grown ' + growing.count() + ' seen ' + seen)

// The box a loop picks outlives the loop and the pushes that move the storage it was read from.
const keeper = makeWorld()
keeper.add(2, 1, 0, 0, 2, 2, 2, true)
const kept = keeper.nearest(0)
for (let n = 0; n < 40; n++) keeper.add(7, 9, 0, 0, 10, 2, 2, true)
console.log('kept ' + (kept === null ? 0 : kept.id))

// Stores into the cell the binding was read from: the window still holds, and
// the binding keeps the element it read rather than seeing its replacement.
const swap = (items: Box[], count: number, spare: Box): string => {
  let before = 0
  for (let i = 0; i < count; i++) {
    const box = items[i]
    items[i] = spare
    before += box.id
  }
  return before + ' then ' + items[0].id
}
const spare: Box = { min: new Vec3(0, 0, 0), max: new Vec3(1, 1, 1), id: 9, solid: true }
const pair: Box[] = [
  { min: new Vec3(0, 0, 0), max: new Vec3(1, 1, 1), id: 1, solid: true },
  { min: new Vec3(0, 0, 0), max: new Vec3(1, 1, 1), id: 2, solid: true }
]
console.log('swapped ' + swap(pair, pair.length, spare))
