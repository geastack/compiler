import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { invocationValueContinuationsOf } from './invocation-facts.js'
import { indexValueFlow } from './value-flow.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-invocation-layout.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const argumentsObjects = censusArgumentsObjects(checker, [file])
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    (value) => checker.getTypeAtLocation(value),
    (owner) => argumentsObjects.usesByOwner.get(owner)
  )
  const methods = new Map<string, ts.MethodDeclaration>()
  const calls = new Map<string, ts.CallExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) methods.set(node.name.text, node)
    if (ts.isCallExpression(node)) calls.set(node.getText(file), node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const frame = (text: string, method: string) => {
    const call = calls.get(text)
    const body = methods.get(method)
    assert.ok(call, `expected call ${text}`)
    assert.ok(body, `expected method ${method}`)
    const fact = ledger.capture(() => authority.invocationFactOf(call)).value
    assert.ok(fact, `expected admitted invocation fact for ${text}`)
    const result = fact.frames.find((candidate) => candidate.body === body)
    assert.ok(result, `expected admitted frame for ${text}`)
    return { call, fact, frame: result, operands: fact.operands }
  }
  return { frame }
}

test('runtime positions exclude TypeScript this and defaults do not masquerade as actual arguments', () => {
  const { frame } = inspect(`
    class Box {
      read(this: Box, first: number = 10, second: number = 20) { return first + second }
    }
    const box = new Box();
    box.read();
    box.read(7);
    box.read.call(box, 8);
  `)
  const omitted = frame('box.read()', 'read').frame
  assert.equal(omitted.layout.arguments.kind, 'positional')
  if (omitted.layout.arguments.kind !== 'positional') assert.fail('expected positional arguments')
  assert.deepEqual(
    omitted.layout.arguments.slots.map((slot) => (slot.kind === 'single' ? slot.defaultActivation : 'rest')),
    ['always', 'always']
  )
  assert.deepEqual(
    omitted.parameters.map((parameter) => (parameter.name as ts.Identifier).text),
    ['first', 'second']
  )
  assert.deepEqual(
    omitted.parameters.map((parameter) => parameter.initializer?.getText()),
    ['10', '20']
  )
  assert.equal(omitted.forwarding.kind, 'values')
  if (omitted.forwarding.kind === 'values')
    assert.deepEqual(
      omitted.forwarding.entries
        .filter((entry) => entry.activation === 'argument-undefined')
        .map((entry) => [entry.value.getText(), entry.activation]),
      [
        ['10', 'argument-undefined'],
        ['20', 'argument-undefined']
      ]
    )
  if (omitted.forwarding.kind === 'values') {
    const receiver = omitted.forwarding.entries.find((entry) => entry.value === omitted.layout.operands.receiver)
    assert.ok(receiver)
    assert.equal(receiver.argumentPosition, null)
    assert.equal(receiver.parameter, null)
  }

  const oneActual = frame('box.read(7)', 'read').frame
  assert.equal(oneActual.layout.arguments.kind, 'positional')
  if (oneActual.layout.arguments.kind !== 'positional') assert.fail('expected positional arguments')
  assert.deepEqual(
    oneActual.layout.arguments.slots.map((slot) => (slot.kind === 'single' ? slot.defaultActivation : 'rest')),
    ['never', 'always']
  )
  assert.equal(oneActual.forwarding.kind, 'values')
  if (oneActual.forwarding.kind === 'values') {
    const actualEntries = oneActual.forwarding.entries.filter((entry) => entry.argumentPosition !== null)
    const defaults = oneActual.forwarding.entries.filter((entry) => entry.activation === 'argument-undefined')
    assert.equal(actualEntries.length, 1)
    assert.equal(actualEntries[0]?.value.getText(), '7')
    assert.deepEqual(
      actualEntries[0]?.uses.map((use) => use.getText()),
      ['first']
    )
    assert.equal(defaults.length, 1)
    assert.equal(defaults[0]?.value.getText(), '20')
    assert.equal(defaults[0]?.argumentPosition, null)
  }

  const explicitThis = frame('box.read.call(box, 8)', 'read')
  assert.equal(explicitThis.operands.receiver?.getText(), 'box')
  assert.deepEqual(
    explicitThis.operands.args.map((argument) => argument.getText()),
    ['8']
  )
  assert.equal(explicitThis.frame.layout.arguments.kind, 'positional')
  if (explicitThis.frame.layout.arguments.kind !== 'positional') assert.fail('expected positional arguments')
  assert.deepEqual(
    explicitThis.frame.layout.arguments.slots.map((slot) => (slot.kind === 'single' ? slot.defaultActivation : 'rest')),
    ['never', 'always']
  )
  assert.equal(explicitThis.frame.forwarding.kind, 'values')
  if (explicitThis.frame.forwarding.kind === 'values') {
    const actualEntries = explicitThis.frame.forwarding.entries.filter((entry) => entry.argumentPosition !== null)
    const defaults = explicitThis.frame.forwarding.entries.filter((entry) => entry.activation === 'argument-undefined')
    assert.equal(actualEntries.length, 1)
    assert.equal(actualEntries[0]?.value.getText(), '8')
    assert.equal(defaults.length, 1)
    assert.equal(defaults[0]?.value.getText(), '20')
    const receiver = explicitThis.frame.forwarding.entries.find((entry) => entry.value === explicitThis.operands.receiver)
    assert.ok(receiver)
    assert.equal(receiver.argumentPosition, null)
    assert.equal(receiver.parameter, null)
  }
})

test('rest actuals continue as array elements and spread argument frames remain unresolved', () => {
  const { frame } = inspect(`
    class Box {
      read(this: Box, first: number = 10, ...tail: number[]) { return tail[0] ?? first }
    }
    const box = new Box();
    box.read(1, 2, 3);
    box.read(...[1, 2]);
  `)
  const rest = frame('box.read(1, 2, 3)', 'read')
  assert.equal(rest.frame.forwarding.kind, 'values')
  if (rest.frame.forwarding.kind === 'values') {
    const actualEntries = rest.frame.forwarding.entries.filter((entry) => entry.argumentPosition !== null)
    assert.equal(actualEntries.length, 3)
    assert.deepEqual(
      actualEntries.map((entry) => entry.value.getText()),
      ['1', '2', '3']
    )
    assert.deepEqual(
      actualEntries[2]?.elementUses.map((use) => use.getText()),
      ['tail']
    )
    assert.deepEqual(invocationValueContinuationsOf(rest.fact, actualEntries[2]!.value), [
      { expression: actualEntries[2]!.elementUses[0], projection: 'array-element' }
    ])
  }

  const spread = frame('box.read(...[1, 2])', 'read').frame
  assert.deepEqual(spread.forwarding, { kind: 'unresolved', reason: 'spread-arguments' })
})

test('default activation separates undefined sources, known values and shadowed names', () => {
  const { frame } = inspect(`
    class Box {
      read(value: unknown = 10) { return value }
    }
    const box = new Box();
    box.read();
    box.read(void 0);
    box.read(undefined);
    box.read(null);
    box.read({});
    box.read([]);
    box.read(() => 1);
    box.read(new Object());
    function shadowed() {
      const undefined = 5;
      box.read((undefined));
    }
    const dynamic: unknown = 2;
    box.read(dynamic);
  `)
  const activation = (callText: string): string => {
    const layout = frame(callText, 'read').frame.layout
    assert.equal(layout.arguments.kind, 'positional')
    if (layout.arguments.kind !== 'positional') assert.fail('expected positional arguments')
    const slot = layout.arguments.slots[0]
    assert.equal(slot?.kind, 'single')
    if (!slot || slot.kind !== 'single') assert.fail('expected a single parameter slot')
    return slot.defaultActivation
  }
  assert.equal(activation('box.read()'), 'always')
  assert.equal(activation('box.read(void 0)'), 'always')
  assert.equal(activation('box.read(undefined)'), 'always')
  assert.equal(activation('box.read(null)'), 'never')
  assert.equal(activation('box.read({})'), 'never')
  assert.equal(activation('box.read([])'), 'never')
  assert.equal(activation('box.read(() => 1)'), 'never')
  assert.equal(activation('box.read(new Object())'), 'never')
  assert.equal(activation('box.read(dynamic)'), 'maybe')
  assert.equal(activation('box.read((undefined))'), 'maybe')
})
