//! expect: record 5.5 6
//! expect: class 7.5 8
//! emitted-has: makeLiveViewWithOrigin<
// A Box has number fields, and the census keeps one of them a `double` (it is
// assigned 0.5 steps) while a getter's body returning `5` is narrowed to a
// `long long`. A Box built by value from a record with that getter was one
// braced initializer, where C++ forbids that narrowing, and failed to compile.
// A getter flowing into a Box now makes the Box a shared record read through a
// live view (the getter runs at each read), so no braced copy is built; the
// braced builder converts a getter's answer to the member's type regardless.
// Both a record literal's getter and a class getter.

interface Box {
  min: number
  max: number
}

const boxes: Box[] = []
for (let n = 0; n < 2; n++) boxes.push({ min: n + 0.5, max: n + 1 })

const fromRecord = {
  get min(): number {
    return 5
  },
  max: 6,
  label: 'record'
}
if (boxes.length > 1) boxes.push(fromRecord)

class FromClass {
  max = 8
  get min(): number {
    return 7
  }
}
const instance = new FromClass()
if (boxes.length > 2) boxes.push(instance)

const describe = (box: Box): string => box.min + 0.5 + ' ' + box.max
console.log('record ' + describe(boxes[2]!))
console.log('class ' + describe(boxes[3]!))
