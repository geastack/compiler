import { Base } from './base.js'
import DefaultValue, { NamedValue, PublishedValue as AliasedValue, ValueRoot } from './values.js'

class HiddenValue extends ValueRoot {}
export class Child extends Base {
  constructor() {
    super()
    this.defaultValue = new DefaultValue()
    this.namedValue = new NamedValue()
    this.aliasedValue = new AliasedValue()
    this.hiddenValue = new HiddenValue()
    this.record = { entry: new DefaultValue(), hidden: new HiddenValue() }
  }
}

/** @param {Base} value */
export function read(value) {
  return [value.defaultValue, value.namedValue, value.aliasedValue, value.hiddenValue, value.record]
}
