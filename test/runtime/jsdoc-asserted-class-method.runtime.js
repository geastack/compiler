class CloneableValue {
  /** @param {number} value */
  constructor(value) {
    this.value = value
  }

  clone() {
    return new CloneableValue(this.value)
  }
}

/** @param {*} value */
function cloneDynamicValue(value) {
  return /** @type {CloneableValue} */ (value).clone()
}

//! expect: 42
console.log(cloneDynamicValue(new CloneableValue(42)).value)
