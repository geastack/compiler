//! expect: planes 123 241
//! expect: added 77
//! emitted-lacks: gea_present_add
// A plane builder stores `vector[u]` with `u` only ever an axis name (three's
// BoxGeometry), so the store can create an own `x`, `y` or `z` and nothing
// else: the class's methods stay prototype methods, called without a check for
// an own property shadowing them.

class Vec {
  x: number
  y: number
  z: number
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
  add(v: Vec): this {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }
}

type Axis = 'x' | 'y' | 'z'
const out: number[] = []
function buildPlane(u: Axis, v: Axis, w: Axis, depth: number): void {
  const vector = new Vec()
  vector[u] = 1
  vector[v] = 2
  vector[w] = depth
  out.push(vector.x + vector.y * 10 + vector.z * 100)
}
buildPlane('z', 'y', 'x', 3)
buildPlane('x', 'z', 'y', 4)
console.log('planes ' + out.join(' '))

const a = new Vec(1, 2, 3)
const b = new Vec(1, 1, 1)
for (let i = 0; i < 3; i++) a.add(b)
console.log('added ' + a.lengthSq())
