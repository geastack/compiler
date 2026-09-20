//! expect: true null undefined
//! expect: true

class LogicalMarker {
  constructor() {
    this.isMarker = true
  }
}

/** @param {*} value */
function inspectMarker(value) {
  return value && value.isMarker
}

console.log(inspectMarker(new LogicalMarker()), inspectMarker(null), inspectMarker(undefined))
console.log(inspectMarker(new LogicalMarker()) === true)
