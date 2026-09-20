//! expect: 11 22 true 22 11 true
//! emitted-lacks: gea::Optional<gea::Value>
class First {
  first = 11
}
class Second {
  second = 22
}
const first = new First()
const second = new Second()
const map = new Map<string, Second | First>()
const weak = new WeakMap<First | Second, Second | First>()
map.set('first', first)
map.set('second', second)
weak.set(first, second)
weak.set(second, first)
function readMap(key: string): First | Second | undefined {
  return map.get(key)
}
function readWeak(key: First | Second): First | Second | undefined {
  return weak.get(key)
}
function numberOf(value: First | Second | undefined): number {
  if (value instanceof First) return value.first
  if (value instanceof Second) return value.second
  return -1
}
console.log(
  numberOf(readMap('first')),
  numberOf(readMap('second')),
  readMap('absent') === undefined,
  numberOf(readWeak(first)),
  numberOf(readWeak(second)),
  readWeak(new First()) === undefined
)
