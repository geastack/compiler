// @ts-nocheck
// A runtime-keyed store through a live record view (`view[key] = value` over
// a `Size` the caller's literal is viewed as) writes the ORIGINAL allocation:
// a key the view routes takes its slot, a slot only the source declares
// (`depth`) takes the source's slot, and any other key is created on -- or
// overwritten in -- the source's own expando, in the value's own carrier.
// Every reader sees one object: named reads, the view's own open read
// (`view[key]` under for-in), and the dynamic observers (JSON, Object.keys),
// in creation order. A plain allocation of the target shape stores the key in
// its own expando. Both the proven-key form (`Record<string, number>`
// literals) and the unproven one (`any` from JSON.parse) are exercised.

/** @typedef {{ width: number }} Size */

/**
 * @param {Size} view
 * @param {Record<string, number>} params
 */
function fill(view, params) {
  for (const key in params) view[key] = params[key]
  return view
}

/**
 * @param {Size} view
 * @param {any} params
 */
function fillAny(view, params) {
  for (const key in params) view[key] = params[key]
  return view
}

/** @param {Size} view */
function readAll(view) {
  const parts = []
  for (const key in view) parts.push(key + '=' + view[key])
  return parts.join(',')
}

const original = { width: 1, depth: 3 }
const viewed = fill(original, { width: 5, extra: 7, depth: 9 })
console.log('identity ' + (viewed === original))
console.log('json ' + JSON.stringify(original))
console.log('keys ' + Object.keys(original).join(','))
console.log('view ' + readAll(viewed))
fill(original, { extra: 8, later: 2, width: 6 })
console.log('overwrite ' + JSON.stringify(viewed))
console.log('order ' + Object.keys(viewed).join(','))
console.log('named ' + original.width + ':' + viewed.width + ':' + original.depth)
fillAny(original, JSON.parse('{"late":"x","extra":null,"width":4}'))
console.log('dynamic ' + JSON.stringify(original) + ' ' + readAll(original))

const plain = fill({ width: 2 }, { more: 4, width: 3 })
console.log('plain ' + JSON.stringify(plain) + ' ' + readAll(plain))

//! expect: identity true
//! expect: json {"width":5,"depth":9,"extra":7}
//! expect: keys width,depth,extra
//! expect: view width=5,depth=9,extra=7
//! expect: overwrite {"width":6,"depth":9,"extra":8,"later":2}
//! expect: order width,depth,extra,later
//! expect: named 6:6:9
//! expect: dynamic {"width":4,"depth":9,"extra":null,"later":2,"late":"x"} width=4,depth=9,extra=null,later=2,late=x
//! expect: plain {"width":3,"more":4} width=3,more=4
//! emitted-has: gea::record::writeLiveOpenField<gea::NativeFieldOptionalPolicy<false, gea::NativeFieldLeafPolicy>>(
//! emitted-has: gea::record::writeLiveOpenField<gea::NativeFieldLeafPolicy>(
//! emitted-has: gea::nativeObjectDataExtend(gea_field_receiver, gea_field_key, gea_open_write)
