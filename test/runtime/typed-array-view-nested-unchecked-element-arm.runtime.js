// @ts-nocheck
// The nested form of `typed-array-view-unchecked-element-arm`: three's
// `Shape.getPointsHoles` states `Array<Array<Vector2>>` while each hole is a
// curve's `getPoints()`, `Array<Vector2|Vector3>`. Its consumers read the
// holes, reverse one in place and store it back (`holes[ h ] =
// ahole.reverse()`), and hand the whole set to a triangulator stating the
// same nested element. No slot may check an element the program never
// tested; until every stated slot on the way carries the union, it refuses.
//! expect-refusal: has no selected live native array reader
export {}
class V2 {
  /** @param {number} x @param {number} y */
  constructor(x, y) {
    this.x = x
    this.y = y
    this.isVector2 = true
  }
}
class V3 {
  /** @param {number} x @param {number} y @param {number} z */
  constructor(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
    this.isVector3 = true
  }
}
/** @param {boolean} three @param {number} i @return {V2|V3} */
function point(three, i) {
  return three ? new V3(i, -i, i) : new V2(i, -i)
}
/** @param {number} hole @param {boolean} three */
function points(hole, three) {
  const out = []
  for (let i = 0; i < 3; i++) out.push(point(three && i === 2, hole * 10 + i))
  return out
}
/** @param {boolean} three @return {Array<Array<V2>>} */
function holesOf(three) {
  const holes = []
  for (let h = 0; h < 2; h++) holes[h] = points(h, three)
  return holes
}
/** @param {Array<V2>} pts */
function firstX(pts) {
  return pts[0].x
}
/** @param {Array<Array<V2>>} holes */
function flatten(holes) {
  const xs = []
  for (let h = 0; h < holes.length; h++) for (let i = 0; i < holes[h].length; i++) xs.push(holes[h][i].x)
  return xs.join(',')
}
/** @param {boolean} three */
function run(three) {
  const holes = holesOf(three)
  for (let h = 0; h < holes.length; h++) {
    const hole = holes[h]
    if (firstX(hole) > 5) holes[h] = hole.reverse()
  }
  let kinds = ''
  for (const hole of holes) for (const p of hole) kinds += p instanceof V3 ? '3' : '2'
  return holes.length + ' ' + flatten(holes) + ' ' + kinds
}
// Node prints: plain 2 0,1,2,12,11,10 222222
console.log('plain ' + run(false))
// Node prints: mixed 2 0,1,2,12,11,10 223322
console.log('mixed ' + run(true))
