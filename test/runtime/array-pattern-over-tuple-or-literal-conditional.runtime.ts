//! expect: valid:!valid valid:c let:true
// An array pattern over `c ? tupleOf() : [a, true]`: each position reads that
// position of each tuple arm, and a narrower arm widens into the element's
// join -- ajv's jtd `const [valid, cond] = ... ? checkNullableObject(...) : [...]`.
class Name { constructor(readonly str: string) {} }
class Code { constructor(readonly text: string) {} }
type AnyCode = Code | Name
function checkNullable(nullable: boolean): [Name, AnyCode] {
  const valid = new Name('valid')
  return [valid, nullable ? new Code('!valid') : new Name('c')]
}
const describe = (c: AnyCode | boolean): string => (typeof c === 'boolean' ? String(c) : c instanceof Name ? c.str : c.text)
function run(discriminator: string | undefined, nullable: boolean): string {
  const [valid, cond] = discriminator === undefined ? checkNullable(nullable) : [new Name('let'), true]
  return valid.str + ':' + describe(cond)
}
console.log(run(undefined, true), run(undefined, false), run('tag', true))
