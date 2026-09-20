//! expect: primitive
//! expect: primitive
//! expect: primitive
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

class Marker {
  constructor() {
    this.isMarker = true
  }

  label() {
    return 'marker'
  }
}

/** @returns {string} */
function describe(value) {
  if (value && value.isMarker) {
    const marked = { value: /** @type {Marker} */ (value) }
    return marked.value.label()
  }
  return 'primitive'
}

console.log(describe(1))
console.log(describe(true))
console.log(describe('text'))
