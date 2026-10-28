//! expect-refusal: native-boundary:FunctionConstructor

// `Function.prototype.toString` is compiled as the builtin only when the
// `Function` it is read from IS the global. A program-declared global of the
// same type can hold any object, so type identity is not enough: here Node
// prints `fake toString`, and treating the read as the builtin would print
// the arrow's source instead.
export {}
declare global {
  var FakeFunction: FunctionConstructor
}
;(globalThis as any).FakeFunction = {
  prototype: {
    toString() {
      return 'fake toString'
    }
  }
}
const fnToString = FakeFunction.prototype.toString
console.log(fnToString.call(() => 1))
