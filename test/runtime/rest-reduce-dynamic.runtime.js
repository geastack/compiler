//! dynamic-fallback
//! expect: sum 6 1.75 0
//! expect: noinit 6 1.75
//! expect: fixed 10 x:1.5
//! expect: objects 3.5 a|b
//! expect: right cba 1.75
//! expect: classes 3.5 1.25,3.25
// An unannotated rest parameter takes its element carrier from its callers
// (`number[]`) while the reducer's own `(a, b)` stays dynamic, so the call
// hands a `double` element and an `int` literal seed to a callback of
// `(gea::Value, gea::Value)`. That emitted C++ which did not compile: the
// accumulator was deduced from `(0)` and the element was passed unconverted.
function sum(...xs) {
  return xs.reduce((a, b) => a + b, 0)
}
console.log('sum', sum(1, 2, 3), sum(0.5, 0.25, 1), sum())

function sumNoInit(...xs) {
  return xs.reduce((a, b) => a + b)
}
console.log('noinit', sumNoInit(1, 2, 3), sumNoInit(0.5, 0.25, 1))

function scaled(factor, ...xs) {
  return xs.reduce((a, b) => a + b + factor, 0)
}
function tagged(label, ...xs) {
  return xs.reduce((a, b) => a + b, label + ':')
}
console.log('fixed', scaled(1.5, 3, 4), tagged('x', 1.5))

function total(...items) {
  return items.reduce((a, item) => a + item.weight, 0)
}
function names(...items) {
  return items.reduce((a, item) => (a === '' ? item.name : a + '|' + item.name), '')
}
console.log(
  'objects',
  total({ name: 'a', weight: 1.25 }, { name: 'b', weight: 2.25 }),
  names({ name: 'a', weight: 1 }, { name: 'b', weight: 2 })
)

function joinRight(...parts) {
  return parts.reduceRight((acc, x) => acc + x, '')
}
function productRight(...xs) {
  return xs.reduceRight((acc, x) => acc + x)
}
console.log('right', joinRight('a', 'b', 'c'), productRight(0.5, 0.25, 1))

// The element reaches the callback's dynamic parameter inside the runtime
// template, so the element's struct must carry the field protocol a box is
// read through -- `map` had the same gap before `reduce` reached it.
class Item {
  constructor(name, weight) {
    this.name = name
    this.weight = weight
  }
}
function weights(...items) {
  return items.map((item, i) => i + item.weight).join(',')
}
console.log('classes', total(new Item('a', 1.25), new Item('b', 2.25)), weights(new Item('a', 1.25), new Item('b', 2.25)))
