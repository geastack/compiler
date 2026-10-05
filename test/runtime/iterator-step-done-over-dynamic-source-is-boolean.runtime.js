// @ts-nocheck
//! expect: 1,2 | a,b
// A loop over a value read off a proxy: the trap decides what the loop walks,
// so the element is `dynamic`, but the step's `done` is IteratorComplete, a
// ToBoolean, whatever the trap answered -- it stays a native boolean. Carrying
// it as `dynamic` printed a `bool` store into a `gea::Value`. three's
// `nodes/accessors/Camera.js` (`for ( const subCamera of camera.cameras )`,
// `camera` from TSL's builder proxy) and `TSLCore.js`'s `ShaderNodeObjects`
// (`for ( const name in objects )`) are these loops.
const handler = { get: (target, key) => target[key] }
const builder = new Proxy({ camera: { cameras: [{ projectionMatrix: 1 }, { projectionMatrix: 2 }] }, members: { a: 1, b: 2 } }, handler)
function projections(camera) {
  const matrices = []
  for (const subCamera of camera.cameras) matrices.push(subCamera.projectionMatrix)
  return matrices
}
function names(objects) {
  const out = []
  for (const name in objects) out.push(name)
  return out
}
console.log(projections(builder.camera).join(','), '|', names(builder.members).join(','))
