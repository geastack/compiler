//! expect: own function () { return 1 }
//! expect-abort

// `Function.prototype.toString` answers a callable's source text from the facts
// its call record published. A host builtin such as `Math.max` publishes none,
// so the runtime's only answer is the anonymous placeholder, and Node prints
// `function max() { [native code] }`. Refusing is the honest answer until host
// builtins publish their names; then this program should print that text.
const fnToString = Function.prototype.toString
// prettier-ignore
const own = function () { return 1 }
console.log('own', fnToString.call(own))
console.log(fnToString.call(Math.max))
