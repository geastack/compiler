// @ts-nocheck
//! expect-refusal: the @param type of parameter "library" of addType was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// The field `this.map = new WeakMap()` states nothing, and the checker types
// it `WeakMap<object, any>`: another key and value than the `@param
// {WeakMap<Key, number>} library` it is passed to. The tag is erased, and
// `callback.bind( this )` leaves the census of `addType`'s callers open. As a
// dynamic parameter `library` would take the native `WeakMap` boxed; it is
// refused instead.
class Key {
  value = 1
}
class Library {
  constructor() {
    this.key = new Key()
    this.map = new WeakMap()
    this.map.set(this.key, 0)
    this.addType(this.key, this.map)
  }
  /** @param {Key} key @param {WeakMap<Key, number>} library */
  addType(key, library) {
    return library.has(key)
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.library = new Library()
  }
}
new Holder()
console.log('unreachable')
