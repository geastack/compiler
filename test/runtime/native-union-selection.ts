class SelectedPoint {
  x: number
  constructor(x: number) {
    this.x = x
  }
}

type SelectedValue = number | string | SelectedPoint | number[] | Float32Array

function describeSelection(value: SelectedValue | null | undefined): string {
  if (value instanceof SelectedPoint) {
    value.x += 1
    return `point:${value.x}`
  }
  if (Array.isArray(value)) return `array:${value[0]}`
  if (value instanceof Float32Array) return `typed:${value[0]}`
  if (typeof value === 'number') return `number:${value + 1}`
  if (typeof value === 'string') return `string:${value}`
  return value === null ? 'null' : 'undefined'
}

const point = new SelectedPoint(2)
console.log(describeSelection(point))
console.log(point.x)
console.log(describeSelection([4]))
console.log(describeSelection(new Float32Array([6])))
console.log(describeSelection(8))
console.log(describeSelection('ten'))
console.log(describeSelection(null))
console.log(describeSelection(undefined))

//! expect: point:3
//! expect: array:4
//! expect: typed:6
//! expect: number:9
//! expect: string:ten
//! expect: null
//! expect: undefined
