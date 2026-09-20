// A class field stays in its selected native carrier when defineProperty
// replaces its default descriptor during construction. The attribute bits are
// then shared by reflection, enumeration, and ordinary strict field writes.
//! emitted-has: applyNativeFixedDataDescriptor
class FixedBase {
  /** @param {number} value */
  constructor(value) {
    Object.defineProperty(this, 'id', { value })
  }

  /** @param {number} value */
  write(value) {
    this.id = value
  }

  read() {
    return this.id
  }
}

class FixedId extends FixedBase {
  marker = 1
}

const item = new FixedId(41)
console.log(item.read(), Object.keys(item).join(','))
//! expect: 41 marker

try {
  item.write(99)
} catch (error) {
  console.log(error instanceof Error ? error.name : 'unexpected', item.read())
}
//! expect: TypeError 41
