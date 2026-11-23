//! expect: sum 3.000 6.000 9.000 count 3
//! expect: wide label w!
//! expect: scaled 2.000 own 7
//! emitted-has: readLiveFieldBorrowed
//! emitted-has: nativeExpandoPresent(gea_shadow_receiver)
// `unit.pos.x` off a record a live view may stand in for reads `pos` only to
// read `x` off it, so the handle is borrowed, not retained and released: the
// plain allocation answers its own member, and a live view's answer is held
// for the rest of the expression. A wider record pushed into the same list is
// such a view. A method call a dynamic write may shadow takes its receiver by
// reference into the guard, and a shadowing write is still the one called.

class Vec {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
  scale(s: number): number {
    return this.x * s
  }
}

interface Unit {
  pos: Vec
  speed: number
}

const units: Unit[] = []
const add = (x: number): void => {
  units.push({ pos: new Vec(x, x * 2), speed: 1 })
}
add(0.5)
add(1)
const wide = { pos: new Vec(1.5, 3), speed: 2, label: 'w' }
if (units.length > 1) units.push(wide)

const xOf = (unit: Unit): number => unit.pos.x
const yOf = (unit: Unit): number => unit.pos.y
let sumX = 0
let sumY = 0
for (const unit of units) {
  sumX += xOf(unit)
  sumY += yOf(unit)
}
console.log('sum ' + sumX.toFixed(3) + ' ' + sumY.toFixed(3) + ' ' + (sumX * 3).toFixed(3) + ' count ' + units.length)
console.log('wide label ' + wide.label + '!')

function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
const plain = new Vec(1, 0)
const shadowed = new Vec(1, 0)
install(shadowed, 'scale', () => 7)
console.log('scaled ' + plain.scale(2).toFixed(3) + ' own ' + shadowed.scale(2))
