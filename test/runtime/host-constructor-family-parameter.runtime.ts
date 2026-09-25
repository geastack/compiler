//! dynamic-fallback
//! expect: true true false false true true
// A parameter typed by a host constructor family's base (`ErrorConstructor`,
// which lib's six NativeError constructors extend) holds whichever member the
// caller passed: its prototype read answers that member's own prototype, and
// `instanceof` against it asks that member's own [[HasInstance]].
function linkedIsA(Base: ErrorConstructor, probe: ErrorConstructor): boolean {
  return Object.create(Base.prototype) instanceof probe
}
function defaultedIsA(probe: ErrorConstructor, Base: ErrorConstructor = Error): boolean {
  return Object.create(Base.prototype) instanceof probe
}
console.log(
  linkedIsA(TypeError, TypeError),
  linkedIsA(TypeError, Error),
  linkedIsA(Error, TypeError),
  linkedIsA(RangeError, TypeError),
  defaultedIsA(Error),
  defaultedIsA(SyntaxError, SyntaxError)
)
