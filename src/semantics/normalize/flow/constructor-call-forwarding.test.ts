import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { closedConstructorForwardingTargetsOf } from './member-call-forwarding.js'

const inspect = (source: string, superCall = false, constructorText = 'Forwarded') => {
  const entry = resolve('test/fixtures/constructor-call-forwarding.ts')
  const options = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, 'export {};\n' + source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const args = censusArgumentsObjects(checker, [file])
  let call: ts.CallExpression | ts.NewExpression | null = null
  const visit = (node: ts.Node): void => {
    if (
      superCall
        ? ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword
        : ts.isNewExpression(node) && node.expression.getText() === constructorText
    )
      call = node as ts.CallExpression | ts.NewExpression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(call)
  return closedConstructorForwardingTargetsOf(checker, flow, call, (owner) => args.usesByOwner.get(owner))
}

test('source constructors forward into explicit and inherited formal slots', () => {
  for (const declarations of [
    'class Forwarded { constructor(value: object) { void value } }',
    'class Base { constructor(value: object) { void value } } class Forwarded extends Base {}'
  ])
    assert.equal(inspect(declarations + 'new Forwarded({});')?.[0]?.parameters[0]?.name.getText(), 'value')
  assert.deepEqual(inspect('class Forwarded {} new Forwarded();'), [])
  assert.equal(
    inspect(
      'class Base { constructor(value: object) { void value } } class Forwarded extends Base { constructor(value: object) { super(value) } } new Forwarded({});',
      true
    )?.[0]?.parameters[0]?.name.getText(),
    'value'
  )
})

test('ordinary constructor forwarding cannot discard arguments aliases or substitute a different receiver', () => {
  for (const body of [
    'constructor(value: object) { external(arguments[0]) }',
    'constructor(value: object) { const expose = () => external(arguments[0]); expose() }',
    'constructor(...values: object[]) { external(values) }',
    'constructor(value: object) { return value }'
  ])
    assert.equal(inspect(`declare function external(value: unknown): void; class Forwarded { ${body} } new Forwarded({});`), null)
  assert.equal(inspect('declare const external: new (value: object) => object; const Forwarded = external; new Forwarded({});'), null)
})

test('conditional constructor selection forwards every closed source frame', () => {
  const prefix = 'declare const choose: boolean; class First { constructor(one: object) {} } class Second { constructor(two: object) {} }'
  const expression = '(choose ? First : Second)'
  assert.deepEqual(
    inspect(prefix + `new ${expression}({});`, false, expression)
      ?.map((target) => target.parameters[0]?.name.getText())
      .sort(),
    ['one', 'two']
  )
  assert.equal(
    inspect(
      prefix + 'declare const external: new (value: object) => object; new (choose ? First : external)({});',
      false,
      '(choose ? First : external)'
    ),
    null
  )
  assert.equal(
    inspect(
      prefix + 'declare function external(value: unknown): void; external(choose ? First : Second); new (choose ? First : Second)({});',
      false,
      expression
    ),
    null
  )
  assert.equal(
    inspect(
      'declare const choose: boolean; class First {} class Second { constructor(value: object) { return value } } new (choose ? First : Second)({});',
      false,
      expression
    ),
    null
  )
  assert.equal(
    inspect(
      'declare const choose: boolean; class First {} class Second { constructor(value: object) { console.log(arguments[0]) } } new (choose ? First : Second)({});',
      false,
      expression
    ),
    null
  )
})
