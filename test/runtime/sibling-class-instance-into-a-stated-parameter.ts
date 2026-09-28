//! expect: n:a c:b
// ajv's `cxt.block$data(nil, loopAllRequired)`: `block$data(valid: Name, ...)`
// states `Name`, and `nil` is a `_Code` -- a sibling class the checker admits
// for its shape. The slot holds whichever instance arrives.
abstract class CodeOrName {
  abstract text(): string
}
class NameCode extends CodeOrName {
  readonly s: string
  constructor(s: string) {
    super()
    this.s = s
  }
  text(): string {
    return 'n:' + this.s
  }
}
class PlainCode extends CodeOrName {
  readonly s: string
  constructor(s: string) {
    super()
    this.s = s
  }
  text(): string {
    return 'c:' + this.s
  }
}
const nil = new PlainCode('b')
function block(valid: NameCode): string {
  return valid.text()
}
console.log(block(new NameCode('a')), block(nil))
