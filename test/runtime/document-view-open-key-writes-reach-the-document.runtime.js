// @ts-nocheck
// A runtime-keyed store over a record shape that is also the target of a live
// Document view, with no index sidecar of its own: the plain allocation keeps
// an undeclared key in its own expando, in the value's carrier, and the
// viewed Document takes it as its own entry. Both read back through JSON and
// Object.keys in creation order.

function blank() {
  const data = { type: 'BufferGeometry', metadata: { version: 4.7, generator: 'blank' } }
  data.uuid = 'u'
  return data
}

/**
 * @param {ReturnType<typeof blank>} data
 * @param {Record<string, any>} parameters
 */
function serialize(data, parameters) {
  for (const key in parameters) {
    if (parameters[key] !== undefined) data[key] = parameters[key]
  }
  return data
}

const fresh = serialize(blank(), { width: 1, height: undefined, uuid: 'v' })
console.log('fresh ' + JSON.stringify(fresh) + ' ' + Object.keys(fresh).join(','))
serialize(fresh, { width: 2, depth: 5 })
console.log('again ' + JSON.stringify(fresh))
const wire = JSON.parse('{"metadata":{"version":1},"kept":true,"depth":0}')
const restored = serialize(wire, { depth: 2, radius: 3 })
console.log('restored ' + (restored === wire) + ' ' + JSON.stringify(wire) + ' ' + Object.keys(restored).join(','))

//! expect: fresh {"type":"BufferGeometry","metadata":{"version":4.7,"generator":"blank"},"uuid":"v","width":1} type,metadata,uuid,width
//! expect: again {"type":"BufferGeometry","metadata":{"version":4.7,"generator":"blank"},"uuid":"v","width":2,"depth":5}
//! expect: restored true {"metadata":{"version":1},"kept":true,"depth":2,"radius":3} metadata,kept,depth,radius
//! emitted-has: gea::record::makeDocumentViewWithOrigin<
//! emitted-has: gea::nativeObjectDataExtend(gea_field_receiver, gea_field_key, gea_open_write)
