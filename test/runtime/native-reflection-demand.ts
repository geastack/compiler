//! expect: 3
//! expect: x
//! expect: y
//! emitted-lacks: gea_readOwnField(
//! emitted-lacks: gea::Value::box(

function readPoint(): void {
  const point = { x: 1, y: 2 }
  console.log(point.x + point.y)
  for (const key in point) console.log(key)
}
readPoint()
