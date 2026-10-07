// @ts-nocheck
//! expect: true true false
//! emitted-has: gea::TaggedUnion<gea::Ref<gea::Map<std::string, double>>, gea::Ref<gea::Map<double, double>>>
//! emitted-has: .get<0>()->has(
//! emitted-lacks: gea::Value::box(gea::Value::Tag::Object, static_cast<gea::Ref<gea::Map<
// The `@param {Map<string|number, number>} library` tag is contradicted by
// both maps passed to it (gea carries a map by its key and value carriers),
// and erased. Every caller of `addType` is counted, so the census types
// `library` as the union of the two maps: each map keeps its own native
// storage, and `has` dispatches on the arm. No map is boxed.
class Library {
  constructor() {
    this.map = new Map([['k', 0]])
    this.numbers = new Map([[1, 0]])
    this.results = [this.addType('k', this.map), this.addType(1, this.numbers), this.addType(2, this.numbers)]
  }
  /** @param {string|number} key @param {Map<string|number, number>} library */
  addType(key, library) {
    return library.has(key)
  }
}
console.log(new Library().results.join(' '))
