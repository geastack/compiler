// @ts-nocheck
//! expect-refusal: the @param type of parameter "library" of addType was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// three's `NodeLibrary.addType( nodeClass, type, library )` states `@param
// {Map<string|number, ...>} library` and is passed a `Map<string, ...>` and a
// `Map<number, ...>`. gea carries a map by its key and value carriers, so each
// argument contradicts the tag and the tag is erased. `callback.bind( this )`
// leaves the census of `addType`'s callers open, so the census cannot type
// `library` from its complete callers. Carried as `any`, both typed maps would
// be boxed at the call and `library.has` read off a box; the parameter is
// refused instead, with the census's reason.
class Library {
  constructor() {
    this.map = new Map([['k', 0]])
    this.addType('k', this.map)
    this.numbers = new Map([[1, 0]])
    this.addType(1, this.numbers)
  }
  /** @param {string|number} key @param {Map<string|number, number>} library */
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
