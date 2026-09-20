export class ValueRoot {
  constructor() {
    this.amount = 7
  }
}
class DefaultValue extends ValueRoot {}
export default DefaultValue
export class NamedValue extends ValueRoot {}
class AliasedValue extends ValueRoot {}
export { AliasedValue as PublishedValue }
