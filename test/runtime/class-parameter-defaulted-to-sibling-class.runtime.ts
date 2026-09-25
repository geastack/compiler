//! expect: empty  <nil>=false | v=true set v v=false
// A parameter stated as one class and defaulted to an instance of a sibling
// class TypeScript accepts structurally: the cell holds both, compared by
// identity -- ajv's `check$data(valid: Name = nil)` with `nil = new _Code('')`.
abstract class CodeOrName {
  abstract readonly str: string
  abstract emptyStr(): boolean
  toString(): string { return this.str }
}
class Name extends CodeOrName {
  readonly str: string
  constructor(s: string) { super(); this.str = s }
  emptyStr(): boolean { return false }
}
class Code extends CodeOrName {
  readonly items: string[]
  constructor(s: string) { super(); this.items = [s] }
  get str(): string { return this.items.join('') }
  emptyStr(): boolean { return this.items.length === 0 || this.items[0] === '' }
}
type AnyCode = Code | Name
const nil = new Code('')
const assign = (lhs: AnyCode, rhs: boolean): string => `${lhs.str || '<nil>'}=${rhs}`
function check(valid: Name = nil): string {
  const out: string[] = []
  if (valid !== nil) out.push(assign(valid, true))
  out.push(valid.emptyStr() ? 'empty' : 'set', String(valid), assign(valid, false))
  return out.join(' ')
}
console.log(check(), '|', check(new Name('v')))
