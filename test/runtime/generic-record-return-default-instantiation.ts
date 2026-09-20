// tsc: `function evaluatorResult<T>(value: T, ...): EvaluatorResult<T>` returns
// an object literal, and callers declared to return the DEFAULT instantiation
// `EvaluatorResult` write `return evaluatorResult(0)` -- the copy's by-value
// `EvaluatorResult<number>` record must enter a slot typed as the interface's
// default instantiation.
interface EvaluatorResult<T extends string | number | undefined = string | number | undefined> {
  value: T
  isSyntacticallyString: boolean
  resolvedOtherFiles: boolean
}
function evaluatorResult<T extends string | number | undefined>(
  value: T,
  isSyntacticallyString = false,
  resolvedOtherFiles = false
): EvaluatorResult<T> {
  return { value, isSyntacticallyString, resolvedOtherFiles }
}
function evaluate(kind: number): EvaluatorResult {
  if (kind === 0) return evaluatorResult(0)
  if (kind === 1) return evaluatorResult('s', true)
  return evaluatorResult(undefined)
}
const a = evaluate(0)
const b = evaluate(1)
const c = evaluate(2)
console.log(a.value, a.isSyntacticallyString, b.value, b.isSyntacticallyString, c.value === undefined)
//! expect: 0 false s true true
