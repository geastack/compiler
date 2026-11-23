//! expect: quad 0 0 0 0 0.5 -2 0.25 -3 dropped 2
//! expect: wrote 0 0 0.5 -1 0.25 -2 0.125 -3
//! expect: aliased 1065353216 1065353216 1065353216
//! expect: below 9 0 9 0
//! expect: fraction 0 0 0 0 whole 0 7 7 7
//! emitted-has: gea::denseCheckedIndex(
//! emitted-has: gea_dense_extent_
// A loop that writes a typed view at a strided index -- a vertex writer's
// `position[v * 2 + 1]` -- takes the view's pointer and length once and checks
// each index against that length: an index past the end, or below zero, still
// drops its write. A store through one view is seen by a read through another
// view of the same buffer in the same turn.

class Batch {
  out = new Float32Array(8)
  readonly tint = new Float32Array(4)

  constructor() {
    this.tint[0] = 0.5
    this.tint[1] = 0.25
    this.tint[2] = 0.125
    this.tint[3] = 1
  }

  emit(first: number): number {
    const out = this.out
    let dropped = 0
    for (let c = 0; c < 4; c++) {
      const v = first + c
      out[v * 2] = this.tint[c]
      out[v * 2 + 1] = -v
      if (v * 2 + 1 >= out.length) dropped++
    }
    return dropped
  }
}

const late = new Batch()
const droppedLate = late.emit(2)
console.log('quad', Array.from(late.out).join(' '), 'dropped', droppedLate)

const early = new Batch()
early.emit(1)
const wrote: number[] = []
for (let i = 0; i < 8; i++) wrote.push(early.out[i])
console.log('wrote', wrote.join(' '))

const shared = (stride: number): number[] => {
  const buffer = new ArrayBuffer(16)
  const floats = new Float32Array(buffer)
  const words = new Uint32Array(buffer)
  const seen: number[] = []
  for (let i = 0; i < 3; i++) {
    floats[i * stride] = 1
    seen.push(words[i * stride])
  }
  return seen
}
console.log('aliased', shared(1).join(' '))

const below = (shift: number): number[] => {
  const view = new Float32Array(4)
  for (let i = 0; i < 4; i++) view[i * 2 - shift] = 9
  return [view[0], view[1], view[2], view[3]]
}
console.log('below', below(2).join(' '))

// A Number index that is not a whole one names no element: the write is dropped.
const fractional = (offset: number): string => {
  const view = new Float32Array(4)
  for (let i = 0; i < 4; i++) view[i * 1 + offset] = 7
  return Array.from(view).join(' ')
}
console.log('fraction', fractional(0.5), 'whole', fractional(1))
