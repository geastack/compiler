// @ts-nocheck
class Configured {
  /** @param {Object} [values] */
  setValues(values) {
    if (values === undefined) return
    console.log(values.color)
  }
}
class Paint extends Configured {
  /** @param {any} parameters */
  constructor(parameters) {
    super()
    this.setValues(parameters)
  }
}
new Configured().setValues()
new Paint(JSON.parse('{"color":7}'))
//! expect: 7
