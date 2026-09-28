//! expect: true false false true
// ajv's `to instanceof Name` where `to` is `EvaluatedProperties | Name`: the
// dictionary arm holds no Name, because no Name is ever converted into one.
class Name {
  readonly str: string
  constructor(str: string) {
    this.str = str
  }
}
type Evaluated = { [K in string]?: true } | true
const isName = (to: Evaluated | Name | undefined): boolean => to instanceof Name
const props: { [K in string]?: true } = { a: true }
console.log(isName(new Name('x')), isName(props), isName(true), isName(new Name('y')))
