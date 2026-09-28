//! expect: a && a.b && a.b.c Code
// ajv's `getData`: `let expr = data` starts as a `Name` and is reassigned a
// `_Code`. The two classes are structurally compatible (`Name` declares no
// private member), so the checker lets the write through, but a class
// reference is nominal: a cell laid out as `Name` cannot hold a `_Code`. The
// cell holds either class, and each is read as itself.
abstract class CodeOrName {
  abstract readonly str: string
  abstract toString(): string
}
class Name extends CodeOrName {
  constructor(readonly str: string) {
    super()
  }
  toString(): string {
    return this.str
  }
}
class Code extends CodeOrName {
  private cached?: string
  constructor(readonly items: readonly string[]) {
    super()
  }
  get str(): string {
    return (this.cached ??= this.items.join(''))
  }
  toString(): string {
    return this.str
  }
}
function getData(pointer: string, root: Name): Code | Name {
  let data: Code | Name = root
  let expr = data
  for (const segment of pointer.split('/')) {
    if (segment) {
      data = new Code([data.str, '.', segment])
      expr = new Code([expr.str, ' && ', data.str])
    }
  }
  return expr
}
const result = getData('b/c', new Name('a'))
console.log(result.str, result instanceof Code ? 'Code' : 'Name')
