//! expect: pushed 0.5 1.4 hits 2
//! expect: inside -0.25 hits 1
//! expect: grew 3
//! emitted-has: gea_dense_ok_
// A loop over boxes that clamps with `Math.min`/`Math.max` and pushes a
// point out of each box takes one dense window: neither a pure `Math` call
// over Numbers nor a store into a class's data field touches an array, and
// each kept a capsule mover's box loop re-checking `boxes` on every turn.
// A store through a setter can run code that grows the array, and still
// sees every box it adds.

class Point {
  constructor(
    public x: number,
    public z: number
  ) {}
}

interface Box {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

let added = 0
class Grower {
  set value(n: number) {
    if (added < 2) {
      added++
      growing.add(n, n, n, n)
    }
  }
}

const makeWorld = () => {
  const boxes: Box[] = []
  return {
    add(minX: number, maxX: number, minZ: number, maxZ: number): void {
      boxes.push({ minX, maxX, minZ, maxZ })
    },
    push(position: Point, radius: number): number {
      let hits = 0
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        const closestX = Math.max(box.minX, Math.min(box.maxX, position.x))
        const closestZ = Math.max(box.minZ, Math.min(box.maxZ, position.z))
        const offsetX = position.x - closestX
        const offsetZ = position.z - closestZ
        const distanceSq = offsetX * offsetX + offsetZ * offsetZ
        if (distanceSq >= radius * radius) continue
        hits++
        if (distanceSq > 1e-10) {
          const distance = Math.sqrt(distanceSq)
          position.x += (offsetX / distance) * (radius - distance)
          position.z += (offsetZ / distance) * (radius - distance)
        } else {
          position.x = box.minX - radius
        }
      }
      return hits
    },
    visit(sink: Grower): number {
      let seen = 0
      for (let i = 0; i < boxes.length; i++) {
        sink.value = i
        seen++
        if (seen > 10) break
      }
      return seen
    }
  }
}

const world = makeWorld()
world.add(0, 1, 0, 1)
world.add(0, 1, 2, 3)
const p = new Point(0.5, 1.5)
const hits = world.push(p, 0.6)
console.log('pushed ' + p.x + ' ' + Math.round(p.z * 10) / 10 + ' hits ' + hits)

const inside = makeWorld()
inside.add(0, 1, 0, 1)
const q = new Point(0.5, 0.5)
const insideHits = inside.push(q, 0.25)
console.log('inside ' + q.x + ' hits ' + insideHits)

const growing = makeWorld()
growing.add(0, 1, 0, 1)
const sink = new Grower()
console.log('grew ' + growing.visit(sink))
