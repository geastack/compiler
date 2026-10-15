//! expect: n=10
//! expect: kinds=dir,spot,point,array,other,other
// `else if (value instanceof SpotLight)` after `Array.isArray(value)` and an earlier
// `instanceof` arm tests a narrowed carrier of `value`: a native selection of
// the union whose only reader was the test. The test reads the object's own
// tags in place now, and the selection is gone; the answers stay the language's.

class V3 {
  x = 0
}
class Col {
  r = 1
}
class DirLight {
  direction = new V3()
  color = new Col()
}
class SpotLight {
  position = new V3()
  direction = new V3()
  color = new Col()
  distance = 3
}
class PointLight {
  position = new V3()
  color = new Col()
  distance = 4
}

type U = number | boolean | number[] | V3 | Col | DirLight | SpotLight | PointLight | DirLight[] | Float32Array | null | undefined

function member(value: U, code: number): U {
  if (Array.isArray(value)) return value[code]
  if (value instanceof DirLight) {
    switch (code) {
      case -1:
        return value.direction
      case -2:
        return value.color
    }
  } else if (value instanceof SpotLight) {
    switch (code) {
      case -3:
        return value.position
      case -1:
        return value.direction
      case -2:
        return value.color
      case -4:
        return value.distance
    }
  } else if (value instanceof PointLight) {
    switch (code) {
      case -3:
        return value.position
      case -2:
        return value.color
      case -4:
        return value.distance
    }
  }
  return undefined
}

const values: U[] = [new DirLight(), new SpotLight(), new PointLight(), [new DirLight()], 3, null]
let n = 0
for (const v of values) for (const c of [-1, -2, -3, -4, 0]) if (member(v, c) !== undefined) n++
console.log('n=' + n)

const kind = (value: U): string =>
  Array.isArray(value)
    ? 'array'
    : value instanceof DirLight
      ? 'dir'
      : value instanceof SpotLight
        ? 'spot'
        : value instanceof PointLight
          ? 'point'
          : 'other'
console.log('kinds=' + values.map(kind).join(','))
