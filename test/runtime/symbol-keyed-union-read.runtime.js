//! dynamic-fallback
//! expect: union a 3
//! expect: dynamic literal 1 2
// A program symbol keys a record field; read through a parameter that holds
// differently-shaped records, and stored into a literal that is a dynamic
// object, the key is the symbol itself, never its declaration spelled as a
// string property name.
const kLabel = Symbol('label')
function readLabel(context) {
  return context[kLabel]
}
console.log('union', readLabel({ [kLabel]: 'a' }), readLabel({ [kLabel]: 3 }))
function mixed(name) {
  return { [kLabel]: 1, [name.value]: 2 }
}
const made = mixed({ value: 'other' })
console.log('dynamic literal', made[kLabel], made.other)
