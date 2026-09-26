// @ts-nocheck
//! expect: add()|+|op|mul() sub none
// A cell initialized from a `null`-defaulted parameter and renamed through a
// setter stored on the returned function: three's `ShaderNodeProxy( NodeClass,
// scope = null )` reads `let name = scope`, and `fn.setName = ( value ) => {
// name = value }` fills it later. The checker types the cell `null`; it holds
// whatever string the operator or the setter wrote, and the name is read
// through a RegExp test and a concatenation.
const proxy = function (scope = null) {
  let fn, name = scope
  function label() {
    let tslName
    if (name) tslName = /[a-z]/i.test(name) ? name + '()' : name
    else tslName = 'op'
    return tslName
  }
  fn = () => label()
  fn.setName = (value) => {
    name = value
    return fn
  }
  return fn
}
const add = proxy('+').setName('add')
const plus = proxy('+')
const raw = proxy()
const mul = proxy().setName('mul')
// The same cell with no setter: its census answer is the parameter's.
const fixed = function (scope = null) {
  let name = scope
  return () => (name ? name : 'none')
}
console.log([add(), plus(), raw(), mul()].join('|') + ' ' + fixed('sub')() + ' ' + fixed()())
