//! expect: default 1
//! expect: supplied 7

/**
 * @typedef {Object} ConstructorOptions
 * @property {number} [value]
 */

class DefaultedRecordConstructor {
  /**
   * @param {string} label
   * @param {ConstructorOptions} [options]
   */
  constructor(label = 'default', options = {}) {
    this.label = label
    this.value = typeof options.value === 'number' ? options.value : 1
  }
}

const omitted = new DefaultedRecordConstructor()
const supplied = new DefaultedRecordConstructor('supplied', { value: 7 })

console.log(omitted.label, omitted.value)
console.log(supplied.label, supplied.value)
