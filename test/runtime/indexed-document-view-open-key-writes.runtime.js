// @ts-nocheck
// three r185's `BufferGeometry.toJSON`: `for (const key in parameters) {
// if (parameters[key] !== undefined) data[key] = parameters[key] }` over a
// `data` literal whose computed stores give it an index sidecar, and whose
// shape is also the target of a live Document view (a JSON.parse result
// passed where that shape is declared). A key no descriptor names goes where
// JavaScript puts it: the plain allocation's index sidecar -- through the
// very store a receiver that is no view target renders -- or the viewed
// Document's own entry. Named keys keep their slots, a later overwrite stays
// in place, and enumeration keeps creation order.

function toJSON(parameters) {
  const data = { metadata: { version: 4.7, type: 'BufferGeometry', generator: 'toJSON' } }
  data.uuid = 'u'
  for (const key in parameters) {
    if (parameters[key] !== undefined) data[key] = parameters[key]
  }
  return data
}

/**
 * @param {ReturnType<typeof toJSON>} data
 * @param {Record<string, any>} parameters
 */
function patch(data, parameters) {
  for (const key in parameters) {
    if (parameters[key] !== undefined) data[key] = parameters[key]
  }
  return data
}

const fresh = toJSON({ width: 1, height: undefined, uuid: 'v' })
console.log('fresh ' + JSON.stringify(fresh) + ' ' + Object.keys(fresh).join(','))
patch(fresh, { depth: 4, width: 2 })
console.log('patched ' + JSON.stringify(fresh))
const wire = JSON.parse('{"metadata":{"version":1},"kept":true,"depth":0}')
const restored = patch(wire, { depth: 2, radius: 3, uuid: 'w' })
console.log('restored ' + (restored === wire) + ' ' + JSON.stringify(wire) + ' ' + Object.keys(restored).join(','))
console.log('named ' + restored.uuid + ' ' + fresh.uuid + ' ' + fresh.metadata.version)

//! expect: fresh {"metadata":{"version":4.7,"type":"BufferGeometry","generator":"toJSON"},"uuid":"v","width":1} metadata,uuid,width
//! expect: patched {"metadata":{"version":4.7,"type":"BufferGeometry","generator":"toJSON"},"uuid":"v","width":2,"depth":4}
//! expect: restored true {"metadata":{"version":1},"kept":true,"depth":2,"radius":3,"uuid":"w"} metadata,kept,depth,radius,uuid
//! expect: named w v 4.7
//! emitted-has: gea::record::makeDocumentViewWithOrigin<
//! emitted-has: gea::record::writeLiveOpenField<gea::NativeFieldLeafPolicy>(
//! emitted-has: ->gea_writeOwnIndexNative(gea::PropertyKey::string(gea_field_key_input), gea_field_value,
