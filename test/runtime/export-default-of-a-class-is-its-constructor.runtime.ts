//! expect: function 3
// `export default Foo` binds the VALUE `Foo` names -- the constructor. The
// checker answers an export assignment's identifier with the class's instance
// type, which typed the read of the constructor as an instance (ajv's
// `export default Ajv`, beside `module.exports = exports = Ajv`).
class Foo {
  constructor(readonly size: number = 3) {}
}
export default Foo
console.log(typeof Foo, new Foo().size)
