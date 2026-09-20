/** @param {Object} [options] */
function readOptionalOptions(options) {
  return readSuppliedOptions(options)
}

/** @param {*} options */
function readSuppliedOptions(options) {
  if (options === undefined) return -1
  return options.value
}

class OptionalConfiguration {
  /** @param {Object} [options] */
  constructor(options) {
    this.value = options === undefined ? 0 : readSuppliedOptions(options)
  }
}

/** @param {Object} [options] */
function onlyOmittedOptions(options) {
  return options === undefined
}

console.log(readOptionalOptions(), readOptionalOptions({ value: 42 }), readOptionalOptions(undefined))
console.log(new OptionalConfiguration().value, new OptionalConfiguration({ value: 7 }).value)
console.log(onlyOmittedOptions(), onlyOmittedOptions(undefined))
//! expect: -1 42 -1
//! expect: 0 7
//! expect: true true
