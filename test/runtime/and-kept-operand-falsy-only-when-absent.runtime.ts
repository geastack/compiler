//! expect: undefined true false undefined null false
// An `&&` whose left operand has no falsy value but its absence: a union of
// non-empty string literals, or of non-zero numbers, beside `undefined` or
// `null`. The falsy branch keeps only that absence -- ajv's addRule.
type JSONType = 'string' | 'number' | 'object'
type Level = 1 | 2
function addRule(dataType?: JSONType, post?: boolean): string {
  const both = dataType && post
  return `${both}`
}
function levelled(level: Level | null, flag: boolean): string {
  const kept = level && flag
  return `${kept}`
}
console.log(addRule(), addRule('string', true), addRule('number', false), addRule(undefined, true), levelled(null, true), levelled(2, false))
