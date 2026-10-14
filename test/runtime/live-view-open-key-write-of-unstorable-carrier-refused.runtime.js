// @ts-nocheck
// The open-key store through a live view keeps the value in its own carrier
// on the original allocation's expando. A by-value record (`{ inner: 1 }`,
// carried `owned`) has no storage identity a descriptor could hold without
// copying it, so no carrier is certified for the store and the write stays
// refused rather than boxed or guessed. The same program with a storable
// value certifies (`live-view-open-key-writes-reach-the-original`).

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

//! expect-refusal: property-access:native-record-ref:set:native-field-view
