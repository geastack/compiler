// @ts-nocheck
// A typed array whose JSDoc statement is narrower than what it holds. three's
// curve protocol hands `getPoints()` back as `Array<Vector2|Vector3>`, and
// `ShapeUtils.isClockWise( pts )` states `Array<Vector2>`; nothing in the
// program checks which arm an element is, and JavaScript passes a Vector3
// through as is. A native view that checked each element against the
// statement threw `TypeError: dictionary entry has no matching native
// alternative` on the second call. A check the program never wrote must not
// become a throw: until the stated slots carry the union, the view refuses.
//! expect-refusal: has no selected live native array reader
// (`@ts-nocheck` stands in for a library file, whose JSDoc is not checked.)
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
  return three ? new V3(i, i, i) : new V2(i, i)
}
/** @param {boolean} three */
function points(three) {
  const out = []
  for (let i = 0; i < 3; i++) out.push(point(three && i === 1, i))
  return out
}
/** @param {boolean} three @return {Array<V2>} */
function shape(three) {
  const pts = points(three)
  return pts
}
/** @param {Array<V2>} pts */
function sumX(pts) {
  let s = 0
  for (let i = 0; i < pts.length; i++) s += pts[i].x
  return s
}
const plain = shape(false)
const mixed = shape(true)
// Node prints: plain 3 3
console.log('plain ' + plain.length + ' ' + sumX(plain))
// Node prints: mixed 3 3 true
console.log('mixed ' + mixed.length + ' ' + sumX(mixed) + ' ' + (mixed[1] instanceof V3))
