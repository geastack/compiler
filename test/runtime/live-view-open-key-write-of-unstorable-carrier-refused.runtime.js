// @ts-nocheck
// The open-key store through a live view keeps the value in its own carrier
// on the original allocation's expando, and the write stays refused rather
// than boxed or guessed while that expando slot cannot hold the record
// (`native-data-slot`: no complete allocation, writer, absence and storage
// receipt for it). `{ inner: 1 }` was once also refused as an unstorable
// carrier (`native-field-view`), being a by-value record with no identity a
// descriptor could hold; a record stored into a slot no type names is now held
// by reference, so only the slot's refusal remains. The same program with a
// storable value certifies (`live-view-open-key-writes-reach-the-original`).

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
 * @param {'extra' | 'more'} key
 */
function put(view, key) {
  view[key] = { inner: 1 }
  return view
}

const original = { width: 1, depth: 3 }
fill(original, { width: 5, extra: 7, depth: 9 })
fill({ width: 2 }, { more: 4 })
put(original, 'extra')
put(original, 'more')
console.log(Object.keys(original).join(','))

//! expect-refusal: property-access:native-record-ref:set:native-data-slot
