//! expect: known object
//! expect: forwarded object
//! expect: many-known object
//! expect: shape-a object
//! expect: shape-b object
//! expect: shape-c object
//! expect: shape-d object
//! expect: shape-e object
//! expect: shape-f object
//! expect: shape-g object
//! expect: shape-h object
//! expect: shape-i object
//! expect: shape-j object
//! expect: unresolved-known object
//! expect: unresolved-forwarded object

/** @param {Object} value @param {string} label */
function consume(value, label) {
  console.log(label, typeof value)
}

/** @param {*} value */
function forward(value) {
  consume(value, 'forwarded')
}

consume({ color: 1 }, 'known')
forward({ uniforms: 4 })

/** @param {Object} value @param {string} label */
function consumeMany(value, label) {
  console.log(label, typeof value)
}

/** @param {Object} value @param {string} label */
function forwardMany(value, label) {
  consumeMany(value, label)
}

consumeMany({ color: 1 }, 'many-known')
forwardMany({ a: 1 }, 'shape-a')
forwardMany({ b: 2 }, 'shape-b')
forwardMany({ c: 3 }, 'shape-c')
forwardMany({ d: 4 }, 'shape-d')
forwardMany({ e: 5 }, 'shape-e')
forwardMany({ f: 6 }, 'shape-f')
forwardMany({ g: 7 }, 'shape-g')
forwardMany({ h: 8 }, 'shape-h')
forwardMany({ i: 9 }, 'shape-i')
forwardMany({ j: 10 }, 'shape-j')

/** @param {Object} value @param {string} label */
function consumeUnresolved(value, label) {
  console.log(label, typeof value)
}

/** @param {Object} value @param {string} label */
function forwardUnresolved(value, label) {
  // Reassignment prevents call-only inference; the callee must retain this
  // incoming value even when another call supplies a known color record.
  value = value
  consumeUnresolved(value, label)
}

consumeUnresolved({ color: 1 }, 'unresolved-known')
forwardUnresolved({ uniforms: 4 }, 'unresolved-forwarded')
