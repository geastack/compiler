// @ts-nocheck
//! expect: live 4 x
//! emitted-lacks: deadHelper
/** @param {string|number} key */
function typedSink(key) {
  return String(key)
}
function deadHelper(obj, name) {
  return typedSink(name) + Object.getOwnPropertyDescriptor(obj, name)
}
function deadCaller(a, b) {
  return deadHelper(a, b)
}
function live(n) {
  return n + 1
}
function outer() {
  function inner(x) {
    return x * 2
  }
  return inner(1)
}
var callback = function (v) {
  return v + 1
}
class Box {
  constructor(v) {
    this.v = v
  }
  read() {
    return this.v
  }
}
console.log('live', live(1) + outer() + [0].map(callback)[0] - new Box(1).read(), typedSink('x'))
