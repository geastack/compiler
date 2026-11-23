//! expect: gull yaw 0.9375 orbit 0.0625
//! expect: hound yaw -4 speed 2
//! expect: base keys id,hp,update yaw false orbit false
//! expect: gull keys id,hp,type,yaw,orbit,update
//! expect: hound has orbit false speed true
//! expect: sum -3
//! emitted-has: presentOrThrow(v0->yaw)
//! emitted-lacks: noteNativeDeclaredKeyCreated(v0, "yaw")
// An interface family lays out one struct, and a key only some members
// require is optional in it, behind a presence bit: `yaw` and `type` because
// a bare `Base` may be allocated, `orbit` because a Hound never has it. A
// method that reads its own object through the cell holding the literal that
// wrote the key needs no presence test and no presence store -- the
// allocation raised the bit and nothing deletes the key. The bit still
// answers for every other object: a Base allocated without `yaw`, a Hound
// without `orbit`, and the `Enemy` loop reading through the shared array.

interface Base {
  id: number
  hp: number
  update(dt: number): void
}
interface Gull extends Base {
  type: 'gull'
  yaw: number
  orbit: number
}
interface Hound extends Base {
  type: 'hound'
  speed: number
  yaw: number
}
type Enemy = Gull | Hound

const makeGull = (id: number): Gull => {
  const gull: Gull = {
    id,
    hp: 3,
    type: 'gull',
    yaw: 0,
    orbit: 1,
    update(dt: number) {
      gull.yaw += dt * gull.orbit
      gull.orbit *= 0.5
    }
  }
  return gull
}
const makeHound = (id: number): Hound => {
  const hound: Hound = {
    id,
    hp: 5,
    type: 'hound',
    speed: 2,
    yaw: 0,
    update(dt: number) {
      hound.yaw -= dt * hound.speed
    }
  }
  return hound
}
const base: Base = { id: 0, hp: 1, update() {} }
const gull = makeGull(1)
const hound = makeHound(2)
const enemies: Enemy[] = [gull, hound]
for (let i = 0; i < 4; i++) for (const e of enemies) e.update(0.5)
console.log('gull yaw', gull.yaw, 'orbit', gull.orbit)
console.log('hound yaw', hound.yaw, 'speed', hound.speed)
console.log('base keys', Object.keys(base).join(','), 'yaw', 'yaw' in base, 'orbit', 'orbit' in base)
console.log('gull keys', Object.keys(gull).join(','))
console.log('hound has orbit', 'orbit' in hound, 'speed', Object.prototype.hasOwnProperty.call(hound, 'speed'))
let sum = 0
for (const e of enemies) sum += e.yaw + (e.type === 'gull' ? e.orbit : 0)
console.log('sum', sum)
