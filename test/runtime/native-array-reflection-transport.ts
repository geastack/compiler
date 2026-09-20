class ArrayPoint {
  x: number
  constructor(x: number) {
    this.x = x
  }
}

function total(points: ArrayPoint[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index++) sum += points[index]!.x
  return sum
}

const first = new ArrayPoint(4)
const original = [first, new ArrayPoint(7)]
const copied = [...original]
copied[1] = first
copied[0]!.x = 8
console.log(total(original), total(copied), original[0] === copied[1])
copied.length = 1
console.log(copied.length, original.length, total(copied))

//! expect: 15 16 true
//! expect: 1 2 8
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::unbox
