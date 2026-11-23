//! expect: pos 3.000 0.500 -1.000
//! expect: heading 1.000 hp 7 seen 1
//! expect: chained 2.000 4.000 6.000 same true
//! emitted-has: const gea::Ref<gea_class_decl_
//! emitted-lacks: LiteralFieldKey{"pos"
//! emitted-lacks: LiteralFieldKey{"heading"
// A closure's state literal is written once, with the object it allocates, so
// it is a plain allocation for as long as anything reads it: its methods read
// and store its members as members (no live-view route, no copy of `pos`),
// even though a dynamic writer elsewhere makes the record type a view target. A
// method that returns `this` hands back the caller's own handle, so a chain of
// them copies nothing. Each still behaves as before: the state object's fields
// change, `heading` is optional, and the chain returns the receiver itself.

class Vec {
  x = 0
  y = 0
  z = 0
  set(x: number, y: number, z: number): this {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  add(v: Vec): this {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }
  scale(s: number): this {
    this.x *= s
    this.y *= s
    this.z *= s
    return this
  }
}

interface Unit {
  pos: Vec
  vel: Vec
  hp: number
  heading?: number
  step(dt: number): void
  report(): void
}

const seen: unknown[] = []
const observe = (value: unknown): void => {
  seen.push(value)
}
const poke = (target: any, key: string, value: unknown): void => {
  target[key] = value
}

function makeUnit(): Unit {
  const unit: Unit = {
    pos: new Vec(),
    vel: new Vec().set(2, 1, -2),
    hp: 10,
    heading: 0,
    step(dt: number): void {
      unit.pos.add(unit.vel.scale(dt))
      unit.vel.scale(1 / dt)
      unit.hp -= 1
      unit.heading = (unit.heading ?? 0) + 0.25
    },
    report(): void {
      unit.pos.y -= 1
      unit.pos.z += 2
      console.log('pos ' + [unit.pos.x, unit.pos.y, unit.pos.z].map((value) => value.toFixed(3)).join(' '))
      unit.heading = (unit.heading ?? 0) + 0.25
      console.log('heading ' + (unit.heading ?? -1).toFixed(3) + ' hp ' + unit.hp + ' seen ' + seen.length)
    }
  }
  observe({ unit })
  return unit
}

const unit = makeUnit()
if (seen.length > 5) poke(seen[0], 'unit', unit)
for (let i = 0; i < 3; i++) unit.step(0.5)
unit.report()
const v = new Vec()
const chained = v
  .set(1, 2, 3)
  .add(new Vec().set(1, 2, 3))
  .scale(1)
console.log('chained ' + [chained.x, chained.y, chained.z].map((value) => value.toFixed(3)).join(' ') + ' same ' + (chained === v))
