// @ts-nocheck
//! dynamic-fallback
//! expect: c:number a:view b:dataview
// fastify's `deepFreezeObject`: `ArrayBuffer.isView(value)` narrows a value
// read off an untyped object to `ArrayBufferView`, an interface only host
// typed arrays and DataViews implement. The narrowing is a fact about the one
// boxed value, which a record layout would have read as a struct.
function describe (object) {
  const kept = []
  for (const name of Object.getOwnPropertyNames(object)) {
    const value = object[name]
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      kept.push(name + ':view')
      continue
    }
    kept.push(name + ':' + (value instanceof DataView ? 'dataview' : typeof value))
  }
  return kept.join(' ')
}
const bag = JSON.parse('{"c":1}')
bag.a = new Uint8Array(2)
bag.b = new DataView(new ArrayBuffer(4))
console.log(describe(bag))
