// @ts-nocheck
// The precise half of widening a field filled from a bare parameter: every
// caller of `set` passes a number -- a literal, or a member of a record the
// census types -- so the field keeps its native carrier although the
// parameter itself is not typed.
class Slot {
  constructor() {
    this.x = 0
  }
  set(x) {
    this.x = x
    return this
  }
}
const points = [{ x: 2 }, { x: 3 }]
const slot = new Slot()
let sum = 0
for (const point of points) sum += slot.set(point.x).x
console.log(sum + slot.set(4).x)
//! expect: 9
//! emitted-lacks: gea::Value x;
export {}
