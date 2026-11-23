//! expect: rocks=2 reeds=1 toros=1 gates=0
//! expect: m=0,16,16,0

// A game's static-prop placement (Lantern's stage): one pass over a fixed pool
// of records, an else-if chain whose arms each test the record's kind against
// an exported constant and a per-kind pool bound, and write the instance
// matrix at a counter post-incremented inside the call's argument list. The
// whole chain was emitted as nothing: the loop read each record's fields and
// moved on, so every count stayed 0 and no prop was ever drawn.
declare const i32Brand: unique symbol
declare const f32Brand: unique symbol
type i32 = number & { readonly [i32Brand]?: never }
type f32 = number & { readonly [f32Brand]?: never }

export const KIND_NONE = 0
export const KIND_ROCK = 2
export const KIND_REEDS = 5
export const KIND_STONE = 6
export const KIND_TORO = 7
export const KIND_TORII = 8
const ROCK_POOL = 4
const REED_POOL = 4
const TORO_POOL = 4
const GATE_POOL = 2
const PROPS = 6

class Prop {
  kind: i32 = KIND_NONE
  x: f32 = 0
  z: f32 = 0
}

class World {
  props: Prop[] = []
  constructor() {
    for (let i = 0; i < PROPS; i++) this.props.push(new Prop())
  }

  add(kind: number, x: number) {
    for (let i = 0; i < PROPS; i++) {
      const prop = this.props[i]!
      if (prop.kind !== KIND_NONE) continue
      prop.kind = kind
      prop.x = x
      return
    }
  }
}

function place(e: Float32Array, o: i32, x: f32): void {
  e[o] = o
  e[o + 1] = x
}

class Stage {
  rockMatrices = new Float32Array(ROCK_POOL * 16)
  reedMatrices = new Float32Array(REED_POOL * 16)
  toroMatrices = new Float32Array(TORO_POOL * 16)
  gateMatrices = new Float32Array(GATE_POOL * 16)
  counts = ''

  placeStatic(world: World) {
    let rocks = 0
    let reeds = 0
    let toros = 0
    let gates = 0
    for (let i = 0; i < PROPS; i++) {
      const prop = world.props[i]!
      const kind = prop.kind
      const x = prop.x
      if (kind === KIND_ROCK && rocks < ROCK_POOL) place(this.rockMatrices, rocks++ * 16, x)
      else if (kind === KIND_STONE && rocks < ROCK_POOL) {
        const y = x + 1
        place(this.rockMatrices, rocks++ * 16, y)
      } else if (kind === KIND_REEDS && reeds < REED_POOL) place(this.reedMatrices, reeds++ * 16, x)
      else if (kind === KIND_TORO && toros < TORO_POOL) place(this.toroMatrices, toros++ * 16, x)
      else if (kind === KIND_TORII && gates < GATE_POOL) place(this.gateMatrices, gates++ * 16, x)
    }
    this.counts = `rocks=${rocks} reeds=${reeds} toros=${toros} gates=${gates}`
  }
}

const world = new World()
world.add(KIND_ROCK, 3)
world.add(KIND_REEDS, 4)
world.add(KIND_STONE, 5)
world.add(KIND_TORO, 6)
const stage = new Stage()
stage.placeStatic(world)
console.log(stage.counts)
console.log(`m=${stage.rockMatrices[0]},${stage.rockMatrices[16]},${stage.reedMatrices[0]! + 16},${stage.toroMatrices[0]}`)
