class Geometry {
  id = 0
  width = 10
  height = 20
  depth = 30

  constructor() {
    Object.defineProperty(this, 'id', { value: 7, configurable: true })
  }
}

const geometry = new Geometry()
console.log(geometry.id, geometry.width, geometry.height, geometry.depth)
console.log(Object.defineProperty(geometry, 'id', { value: 9 }) === geometry)
console.log(geometry.id, Object.keys(geometry).join(','))

const record = { value: 1, other: 2 }
Object.defineProperty(record, 'value', { value: 3, enumerable: false, writable: false, configurable: false })
Object.defineProperty(record, 'value', { value: 3 })
console.log(record.value, Object.keys(record).join(','))
try {
  Object.defineProperty(record, 'value', { value: 4 })
} catch {
  console.log('protected')
}
