// @ts-nocheck
//! expect: floor true 2
// A named class expression binds its own name to the class object in the class
// scope (15.7.14): fast-json-stringify's `module.exports = class Serializer`
// whose `static restoreFromState(state)` is `new Serializer(state)`.
const Holder = { Serializer: class Serializer {
  constructor (options) { this._options = options }
  getState () { return this._options }
  static restoreFromState (state) { return new Serializer(state) }
  static count () { return Serializer.name.length > 0 ? 2 : 0 }
} }
const first = new Holder.Serializer({ rounding: 'floor' })
const second = Holder.Serializer.restoreFromState(first.getState())
console.log(second.getState().rounding, second instanceof Holder.Serializer, Holder.Serializer.count())
