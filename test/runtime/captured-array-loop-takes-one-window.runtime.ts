//! expect: nearest 2 of 4
//! expect: grown 3 seen 3
//! expect: swapped 7 then 9
//! expect: shrunk 1 seen 2
//! expect: hoisted 3 lowest 1
//! emitted-has: gea_dense_ok_
// A loop bounded by the length of an array a closure captured takes one dense
// window: a collision world's `raycast` walks the `boxes` it shares with
// `addBox`, and every turn re-read the capture, its length, and the bounds and
// view checks of each element. The window holds only while the loop can change
// no array: a loop that calls code that may push or pop, or a capture that is
// rebound, still sees every change. A `const` a hoisted function declaration
// reads before it is declared is boxed, and still holds one array once read.

interface Box {
  min: number
  max: number
  solid: boolean
}

const makeWorld = () => {
  const boxes: Box[] = []
  return {
    addBox(min: number, max: number, solid: boolean): Box {
      const box: Box = { min, max, solid }
      boxes.push(box)
      return box
    },
    nearest(at: number): string {
      let hit: Box | null = null
      let best = Infinity
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        if (!box.solid) continue
        const distance = box.min > at ? box.min - at : at - box.min
        if (distance < best) {
          best = distance
          hit = box
        }
      }
      return 'nearest ' + (hit === null ? 'none' : hit.min) + ' of ' + boxes.length
    },
    visitGrowing(): string {
      let seen = 0
      for (let i = 0; i < boxes.length; i++) {
        seen++
        if (boxes.length < 3) boxes.push({ min: 5, max: 6, solid: false })
        if (seen > 10) break
      }
      return 'grown ' + boxes.length + ' seen ' + seen
    },
    removeLast(): void {
      boxes.pop()
    },
    visitShrinking(drop: () => void): string {
      let seen = 0
      for (let i = 0; i < boxes.length; i++) {
        seen++
        drop()
      }
      return 'shrunk ' + boxes.length + ' seen ' + seen
    }
  }
}

const world = makeWorld()
world.addBox(9, 10, true)
world.addBox(2, 3, true)
world.addBox(1, 2, false)
world.addBox(7, 8, true)
console.log(world.nearest(1))

const growing = makeWorld()
growing.addBox(0, 1, true)
console.log(growing.visitGrowing())

let rebound: number[] = [7, 8]
const firstOf = (): string => {
  let out = ''
  for (let i = 0; i < rebound.length; i++) {
    out += rebound[i]
    rebound = [9]
    if (out.length > 4) break
  }
  return out
}
console.log('swapped ' + firstOf().slice(0, 1) + ' then ' + rebound[0])

const shrinking = makeWorld()
shrinking.addBox(0, 1, true)
shrinking.addBox(1, 2, true)
shrinking.addBox(2, 3, true)
console.log(shrinking.visitShrinking(() => shrinking.removeLast()))

const makeHoistedWorld = () => {
  function lowest(): number {
    let low = Infinity
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      if (cell.min < low) low = cell.min
    }
    return low
  }
  const cells: Box[] = []
  return {
    add: (min: number): number => cells.push({ min, max: min + 1, solid: true }),
    report: (): string => 'hoisted ' + cells.length + ' lowest ' + lowest()
  }
}
const hoisted = makeHoistedWorld()
hoisted.add(4)
hoisted.add(1)
hoisted.add(6)
console.log(hoisted.report())
