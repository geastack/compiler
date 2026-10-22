// @ts-nocheck
// The precise half of an inferred field's dynamic-store widening: a field
// every write of which is typed as the field's own type -- a typed copy from
// another instance -- holds nothing else, so it keeps its native carrier.
class Label {
  constructor(text) {
    this.text = text === undefined ? 'none' : String(text)
    this.width = 0
  }
  copy(source) {
    this.text = source.text
    this.width = source.width
    return this
  }
}

const a = new Label('a')
a.width = 3
const b = new Label().copy(a)
console.log(b.text, b.width + 1)
//! expect: a 4
//! emitted-has: std::string text;
//! emitted-has: double width;
//! emitted-lacks: gea::Value text;
//! emitted-lacks: gea::Value width;
export {}
