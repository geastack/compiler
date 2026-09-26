// @ts-nocheck
//! expect: 3 true
// An untagged `constructor(message, trace = null)` whose callers pass a class
// instance or nothing: the parameter holds what the callers pass, with the
// default's `null`, and so does the field it fills. Typed by the checker's
// bare `null` of the default, the field was laid out as a carrier that holds
// only `null` (three's `NodeError( message, stackTrace = null )`, handed the
// `StackTrace` of the node that failed).
class Trace {
  constructor() {
    this.depth = 3
  }
}
class Failure {
  constructor(message, trace = null) {
    this.message = message
    this.trace = trace
  }
}
const withTrace = new Failure('a', new Trace())
const withoutTrace = new Failure('b')
console.log(withTrace.trace.depth + ' ' + (withoutTrace.trace === null))
