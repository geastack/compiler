// A computed-key write that can reach an instance reserves an own slot for every
// method of its class, so a plain `a.dot(b)` cannot bind the prototype body
// unconditionally: one instance may own `dot`. The call names the body behind a
// test of that instance's own slot, and an instance that does own the key still
// runs its own Function, with its own receiver.

class Vec {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
  dot(other: Vec): number {
    return this.x * other.x + this.y * other.y
  }
  scaled(k: number): Vec {
    return new Vec(this.x * k, this.y * k)
  }
}

const assign = (target: Vec, key: string, value: unknown): void => {
  Reflect.set(target, key, value)
}

const sum = (items: Vec[], probe: Vec): number => {
  let total = 0
  for (const item of items) total += item.dot(probe)
  return total
}

const a = new Vec(1, 2)
const b = new Vec(3, 4)
const odd = new Vec(5, 6)
assign(a, 'x', 10)
console.log('plain', a.dot(b), sum([a, b], b))
odd.dot = function (this: Vec, other: Vec) {
  return -1000 + this.x + other.y
}
console.log('owned', odd.dot(b), sum([a, odd, b], b))
console.log('chained', a.scaled(2).dot(b))

//! expect: plain 38 63
//! expect: owned -991 -928
//! expect: chained 76
//! emitted-has: ->gea_present_dot) ? gea_body_
