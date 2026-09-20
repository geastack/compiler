//! dynamic-fallback
//! expect-abort

/** @param {string|number} value */
function classify(value) {
  return typeof value === 'string' ? value.length : value
}

classify.prototype.kind = 'mutable'

// The dynamic Function object retains classify's exact union frame. An
// arbitrary dynamic boolean cannot cross that typed boundary by coercion.
const wrong = /** @type {*} */ (true)
classify(wrong)
