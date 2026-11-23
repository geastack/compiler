//! expect: slab 4 hits 1 nearest 1.000
//! expect: ground 6
//! expect: argument 1 then 5
//! expect: rebound 1 4
//! expect: stored 0 7
//! emitted-has: = &([&](const auto& gea_field_receiver, gea::Ref<
//! emitted-has: gea_field_slot_
// A slab test reads `box.min` and `box.max` on both arms of each axis branch,
// and the reuse pass carries one read of each across them through a merge.
// Each read, and each merge, now names the field instead of retaining a copy:
// a pointer to the member, or to a frame slot holding a live view's answer
// (the `wide` box is another shape viewed as a Box). A read still copies when
// something between it and a use can change the field: a call handed the read
// that replaces it, a rebinding of the receiver, a store of the key.

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
add(new Vec(4, -1, -1), new Vec(5, 6, 1), true)
add(new Vec(7, -1, -1), new Vec(8, 1, 1), false)
const wide = { min: new Vec(10, -5, -5), max: new Vec(11, 6, 6), solid: true, label: 'wide' }
if (boxes.length > 2) boxes.push(wide)

const slab = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): string => {
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
      if (near > far) {
        const swap = near
        near = far
        far = swap
      }
      if (near > enter) enter = near
      if (far < exit) exit = far
    } else if (ox < box.min.x || ox > box.max.x) continue
    if (dy !== 0) {
      let near = (box.min.y - oy) / dy
      let far = (box.max.y - oy) / dy
      if (near > far) {
        const swap = near
        near = far
        far = swap
      }
      if (near > enter) enter = near
      if (far < exit) exit = far
    } else if (oy < box.min.y || oy > box.max.y) continue
    if (dz !== 0) {
      let near = (box.min.z - oz) / dz
      let far = (box.max.z - oz) / dz
      if (near > far) {
        const swap = near
        near = far
        far = swap
      }
      if (near > enter) enter = near
      if (far < exit) exit = far
    } else if (oz < box.min.z || oz > box.max.z) continue
    if (enter > exit) continue
    hits++
    if (enter < nearest) nearest = enter
  }
  return boxes.length + ' hits ' + hits + ' nearest ' + nearest.toFixed(3)
}
console.log('slab ' + slab(0, 0, 0, 1, 0, 0))

const groundHeight = (x: number, z: number): number => {
  let height = 0
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!
    if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z && box.max.y > height) height = box.max.y
  }
  return height
}
console.log('ground ' + groundHeight(10.5, 0))

// The read is an argument, and an argument evaluated after it replaces the
// field: the callee still sees the vector the read answered.
const replaceMin = (box: Box): number => {
  box.min = new Vec(5, 0, 0)
  return box.min.x
}
const firstX = (min: Vec, later: number): string => min.x + ' then ' + later
const argument = (box: Box): string => firstX(box.min, replaceMin(box))
console.log('argument ' + argument({ min: new Vec(1, 0, 0), max: new Vec(), solid: true }))

// Rebinding the receiver between two reads of the same field.
const rebound = (): string => {
  let box = boxes[0]!
  const before = box.min.x
  box = boxes[1]!
  return before + ' ' + box.min.x
}
console.log('rebound ' + rebound())

// A store of the key between a read and a later use of the same read.
const stored = (box: Box): string => {
  const near = box.max.x
  const max = box.max
  box.max = new Vec(7, 0, 0)
  return Math.round(near + max.x - 2) + ' ' + box.max.x
}
console.log('stored ' + stored({ min: new Vec(), max: new Vec(1, 0, 0), solid: true }))
