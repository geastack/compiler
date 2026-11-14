//! expect: slab 4 hits 1 nearest 1.000
//! expect: store seen 1 5 9
//! expect: call seen 2 7
//! expect: getter 1 2 3
//! expect: loop 13 27
// A slab test reads `box.min` and `box.max` once per axis, on both arms of
// each axis branch; the later reads take the earlier read's value, through a
// phi where the arms meet. Each read still answers what the program wrote:
// a store between two reads of a field, a call that writes it, a getter that
// counts its calls, and a loop whose body rewrites the field every turn.

class Vec {
  x: number
  y: number
  z: number
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
}

interface Box {
  min: Vec
  max: Vec
  solid: boolean
}

const boxes: Box[] = []
const add = (min: Vec, max: Vec, solid: boolean): void => {
  boxes.push({ min, max, solid })
}
add(new Vec(1, -1, -1), new Vec(2, 1, 1), true)
add(new Vec(4, -1, -1), new Vec(5, 1, 1), true)
add(new Vec(7, -1, -1), new Vec(8, 1, 1), false)
const wide = { min: new Vec(10, 5, 5), max: new Vec(11, 6, 6), solid: true, label: 'wide' }
if (boxes.length > 2) boxes.push(wide)

function slab(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): [number, number] {
  let nearest = 100
  let hits = 0
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!
    if (!box.solid) continue
    let enter = 0
    let exit = nearest
    if (dx !== 0) {
      let near = (box.min.x - ox) / dx
      let far = (box.max.x - ox) / dx
      if (near > far) [near, far] = [far, near]
      enter = Math.max(enter, near)
      exit = Math.min(exit, far)
    } else if (ox < box.min.x || ox > box.max.x) continue
    if (dy !== 0) {
      let near = (box.min.y - oy) / dy
      let far = (box.max.y - oy) / dy
      if (near > far) [near, far] = [far, near]
      enter = Math.max(enter, near)
      exit = Math.min(exit, far)
    } else if (oy < box.min.y || oy > box.max.y) continue
    if (dz !== 0) {
      let near = (box.min.z - oz) / dz
      let far = (box.max.z - oz) / dz
      if (near > far) [near, far] = [far, near]
      enter = Math.max(enter, near)
      exit = Math.min(exit, far)
    } else if (oz < box.min.z || oz > box.max.z) continue
    if (enter > exit) continue
    hits++
    nearest = Math.min(nearest, enter)
  }
  return [hits, nearest]
}

const [hits, nearest] = slab(0, 0, 0, 1, 0, 0)
console.log('slab ' + boxes.length + ' hits ' + hits + ' nearest ' + nearest.toFixed(3))

function storeBetween(box: Box): string {
  const first = box.min.x
  box.min = new Vec(5, 0, 0)
  const second = box.min.x
  box.min.x = 9
  return first + ' ' + second + ' ' + box.min.x
}
console.log('store seen ' + storeBetween({ min: new Vec(1, 0, 0), max: new Vec(), solid: true }))

let target: Box | null = null
function move(): void {
  if (target) target.max = new Vec(7, 0, 0)
}
function callBetween(box: Box): string {
  target = box
  const first = box.max.x
  move()
  return first + ' ' + box.max.x
}
console.log('call seen ' + callBetween({ min: new Vec(), max: new Vec(2, 0, 0), solid: true }))

class Counter {
  calls = 0
  get next(): number {
    this.calls++
    return this.calls
  }
}
interface Ticks {
  counter: Counter
}
const ticks: Ticks = { counter: new Counter() }
console.log('getter ' + ticks.counter.next + ' ' + ticks.counter.next + ' ' + ticks.counter.next)

function rewriteInLoop(box: Box): string {
  let sum = 0
  for (let i = 1; i <= 3; i++) {
    sum += box.min.x
    box.min = new Vec(box.min.x + i, 0, 0)
  }
  return sum + ' ' + box.min.x * 3
}
console.log('loop ' + rewriteInLoop({ min: new Vec(3, 0, 0), max: new Vec(), solid: true }))
