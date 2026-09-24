// A runtime-length Array spread into NAMED formals: `f(...xs)` where `f`
// declares no rest parameter where the spread lands. ECMA-262's
// ArgumentListEvaluation iterates `xs` and hands the callee however many
// values came out; the formals bind them left to right, a formal no value
// reaches binds `undefined` (so a default runs), and values past the last
// formal are dropped. Every line below is checked against node's own output.

function f(a?: number, b?: number, c = 7): string {
  return `${a}:${b}:${c}`
}

const none: number[] = []
const two: number[] = [1, 2]
const three: number[] = [1, 2, 3]
const four: number[] = [1, 2, 3, 4]

//! expect: fewer=undefined:undefined:7 1:2:7
console.log(`fewer=${f(...none)} ${f(...two)}`)
//! expect: equal=1:2:3
console.log(`equal=${f(...three)}`)
//! expect: more=1:2:3
console.log(`more=${f(...four)}`)
//! expect: after-plain=10:1:2 10:20:1 10:20:30
// @ts-expect-error TS2556: the checker refuses a spread that lands past every formal; the language drops its values.
const pastEveryFormal = f(10, 20, 30, ...four)
console.log(`after-plain=${f(10, ...two)} ${f(10, 20, ...four)} ${pastEveryFormal}`)

// A fixed formal before a rest formal: the leading values fill the named
// formal, the remainder is range-copied into the rest array.
function g(head?: number, ...tail: number[]): string {
  return `${head}|${tail.length}|${tail.join(',')}`
}
//! expect: rest-after=undefined|0| 1|1|2 1|3|2,3,4
console.log(`rest-after=${g(...none)} ${g(...two)} ${g(...four)}`)

// Methods, constructors and a statically known literal.
class Point {
  x: number
  y: number
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }
  set(x?: number, y?: number): Point {
    if (x !== undefined) this.x = x
    if (y !== undefined) this.y = y
    return this
  }
  label(): string {
    return `(${this.x},${this.y})`
  }
}
//! expect: new=(1,2) (1,0) (0,0) (1,2)
console.log(`new=${new Point(...two).label()} ${new Point(...[1]).label()} ${new Point(...none).label()} ${new Point(...four).label()}`)
//! expect: method=(3,2)
console.log(`method=${new Point(...two).set(...[3]).label()}`)
//! expect: literal=5:6:7 5:6:8
console.log(`literal=${f(...[5, 6])} ${f(5, ...[6], 8)}`)

// `super(...)` and `super.m(...)` forward a runtime-length list into a base
// class's fixed formals.
class Point3 extends Point {
  z: number
  constructor(...xyz: number[]) {
    super(...xyz)
    this.z = xyz[2] ?? -1
  }
  setAll(...xy: number[]): Point {
    return super.set(...xy)
  }
  override label(): string {
    return `(${this.x},${this.y},${this.z})`
  }
}
//! expect: super=(1,2,3) (1,0,-1) (9,2,3)
console.log(`super=${new Point3(...three).label()} ${new Point3(1).label()} ${new Point3(...three).setAll(9).label()}`)

// The source is evaluated exactly once, before the call, even when every
// value it produces is dropped.
let evaluated = 0
const source = (): number[] => {
  evaluated += 1
  return [4, 5, 6, 7]
}
function none0(): string {
  return 'none0'
}
// @ts-expect-error TS2556, as above.
const dropped = none0(...source())
//! expect: evaluated=none0 4:5:6 2
console.log(`evaluated=${dropped} ${f(...source())} ${evaluated}`)
