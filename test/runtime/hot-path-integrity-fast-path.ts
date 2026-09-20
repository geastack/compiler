// Stores to native class fields and array elements guard against
// `Object.freeze` / `preventExtensions` having been applied to THAT object.
// Until any native object has been restricted, the guard must be a single
// counter load, not a lookup in the expando registry -- a `std::map` search
// per store was the September regression behind `method_calls` and
// `array_write`. This program stores through the fast path first, then
// restricts one instance and one array, and checks the restrictions apply to
// exactly those objects while every other store keeps working.
class Point {
  x: number
  y: number
  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }
}

const rejects = (write: () => void): string => {
  try {
    write()
    return 'missing'
  } catch (error) {
    return (error as Error).name
  }
}

const a = new Point(0, 0)
const b = new Point(0, 0)
const cells: number[] = [0, 0, 0, 0]
for (let i = 0; i < 100000; i++) {
  a.x = i
  a.y = a.x - i
  cells[i & 3] = i
}
console.log(a.x, a.y, cells.join(','))

const others: number[] = [1, 1, 1, 1]
Object.freeze(a)
Object.freeze(cells)
console.log(
  Object.isFrozen(a),
  Object.isFrozen(b),
  Object.isFrozen(cells),
  Object.isExtensible(a),
  Object.isExtensible(b),
  Object.isExtensible(others)
)
console.log(
  rejects(() => {
    a.x = 1
  }),
  rejects(() => {
    cells.push(5)
  }),
  rejects(() => {
    cells[0] = 5
  })
)
for (let i = 0; i < 1000; i++) {
  b.x = i
  others[i & 3] = -i
}
console.log(a.x, b.x, cells.join(','), others.join(','))

// A counted store loop over the frozen array: its dense window folds the
// writability check into the loop's one flag, so every store must take the
// cold path and the first must throw.
let frozenStores = 0
console.log(
  rejects(() => {
    for (let i = 0; i < cells.length; i++) {
      cells[i] = i
      frozenStores++
    }
  }),
  frozenStores,
  cells.join(',')
)
