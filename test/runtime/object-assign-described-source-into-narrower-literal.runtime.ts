// `Object.assign(target, source)` where no closed literal family describes
// the source -- a record loaded from `any`, a parameter -- and the target
// literal's layout lacks a key the source's type declares. The source's own
// carrier describes its keys: each typed key the target lacks lands in the
// target's native object data (never a boxed Value), each key it has in its
// own field, and the copy walks the source's keys in its own creation order,
// a Document's entry order included. A run-time key the type does not
// declare is copied too, as the Value it already is.
//
//! emitted-has: gea::nativeObjectDataSet<
//! emitted-lacks: gea::Value::box(gea::Value::Tag::Bool
//! expect: keys x,b,a
//! expect: json {"x":0,"b":1,"a":2}
//! expect: present x,a
//! expect: absent x
//! expect: extra x,a,zeta
//! expect: extra json {"x":0,"a":5,"zeta":"z"}
//! expect: param x,a,b
//! expect: param json {"x":1,"a":3,"b":4}
interface Source {
  a?: number
  b?: number
}

interface Narrow {
  x: number
}

const reordered: Source = JSON.parse('{"b":1,"a":2}')
const first: Narrow = { x: 0 }
Object.assign(first, reordered)
console.log('keys', Object.keys(first).join(','))
console.log('json', JSON.stringify(first))

const partial: Source = JSON.parse('{"a":7}')
const second: Narrow = { x: 0 }
Object.assign(second, partial)
console.log('present', Object.keys(second).join(','))

const empty: Source = JSON.parse('{}')
const third: Narrow = { x: 0 }
Object.assign(third, empty)
console.log('absent', Object.keys(third).join(','))

const wider: Source = JSON.parse('{"a":5,"zeta":"z"}')
const fourth: Narrow = { x: 0 }
Object.assign(fourth, wider)
console.log('extra', Object.keys(fourth).join(','))
console.log('extra json', JSON.stringify(fourth))

const merge = (from: Source): Narrow => {
  const into: Narrow = { x: 1 }
  Object.assign(into, from)
  return into
}
const merged = merge({ a: 3, b: 4 })
console.log('param', Object.keys(merged).join(','))
console.log('param json', JSON.stringify(merged))
