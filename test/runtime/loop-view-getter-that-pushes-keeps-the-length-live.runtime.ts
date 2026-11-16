//! expect: seen 45 4
//! expect: plain 11 2
//! emitted-has: gea_dense_ok_
// `lazy` is another shape viewed as a Box once it lands in `boxes`, and a live
// view reads `min` through its origin's getter -- which pushes onto the array
// the loop walks. Every read in the loop names a data field of `Box`, so only
// the program-wide answer (some getter answers `min`) says the loop can grow
// the array; the length is read each iteration and the elements are not
// borrowed out of storage the push may move. A loop over keys no getter
// answers keeps its window.

class Vec {
  x: number
  constructor(x: number) {
    this.x = x
  }
}

interface Box {
  min: Vec
  max: Vec
}

const world = (count: number): string => {
  const boxes: Box[] = []
  for (let n = 0; n < count; n++) boxes.push({ min: new Vec(n), max: new Vec(n + 1) })
  let grown = 0
  const lazy = {
    get min(): Vec {
      if (grown < 3) {
        grown++
        boxes.push({ min: new Vec(10), max: new Vec(20) })
      }
      return new Vec(5)
    },
    max: new Vec(6),
    label: 'lazy'
  }
  if (boxes.length > 1) boxes.push(lazy)
  let total = 0
  let seen = 0
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]
    total += box.min.x + box.max.x
    seen++
  }
  return total + ' ' + seen
}
console.log('seen ' + world(2))

interface Slab {
  lo: Vec
  hi: Vec
}

const plain = (count: number): string => {
  const slabs: Slab[] = []
  for (let n = 0; n < count; n++) slabs.push({ lo: new Vec(n * 2), hi: new Vec(n * 3 + 3) })
  let total = 0
  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i]
    total += slab.lo.x + slab.hi.x
  }
  return total + ' ' + slabs.length
}
console.log('plain ' + plain(2))
