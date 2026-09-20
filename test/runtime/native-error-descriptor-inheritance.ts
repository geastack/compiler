//! expect: native message

// Merely emitting the subclass must not ask its native base for a generated
// descriptor hook that the base does not implement. No database is needed.
class NativeFailure extends Error {
  constructor() {
    super('native message')
  }
}
console.log(new NativeFailure().message)
