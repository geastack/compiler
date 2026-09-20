import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { wholeProgram } from '../reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import type { SourceInvocationFact } from './invocation-facts.js'
import { indexValueFlow } from './value-flow.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/invocation-dispatch.ts')
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
    (expression) => checker.getTypeAtLocation(expression),
    (owner) => argumentsObjects.usesByOwner.get(owner)
  )
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const fact = (select: (call: ts.CallExpression) => boolean): SourceInvocationFact | null => {
    const call = calls.find(select)
    assert.ok(call, 'expected call exists in the fixture')
    const proof = ledger.capture(() => authority.invocationFactOf(call))
    const repeated = ledger.capture(() => authority.invocationFactOf(call))
    assert.deepEqual(repeated.value, proof.value)
    assert.deepEqual(repeated.requirements, proof.requirements)
    return proof.value
  }
  const callNamed = (text: string) => (call: ts.CallExpression) => call.expression.getText(file) === text
  const callInMethod = (text: string, methodName: string) => (call: ts.CallExpression) => {
    if (!callNamed(text)(call)) return false
    return ts.findAncestor(call.parent, (node) => ts.isMethodDeclaration(node) && node.name.getText(file) === methodName) !== undefined
  }
  const targetNames = (proof: SourceInvocationFact | null): string[] | null =>
    proof?.frames.map((frame) => {
      assert.ok(ts.isMethodDeclaration(frame.body))
      assert.ok(ts.isClassLike(frame.body.parent))
      return `${frame.body.parent.name?.text}.${frame.body.name.getText(file)}`
    }) ?? null
  return { calls, fact, callInMethod, callNamed, file, targetNames }
}

test('ordinary overrides and lexical super calls select different method bodies', () => {
  const checked = inspect(`
    class Base { copy(value: number) { return value } }
    class Derived extends Base {
      copy(value: number) { return super.copy(value) }
      bracket(value: number) { return super['copy'](value) }
      nested(value: number) { return (() => super.copy(value))() }
      throughCall(value: number) { return super.copy.call(this, value) }
      throughApply(value: number) { return super['copy'].apply(this, [value]) }
    }
    const held = new Derived();
    held.copy(1);
    held.bracket(1);
    held.nested(1);
    held.throughCall(1);
    held.throughApply(1);
  `)

  assert.deepEqual(checked.targetNames(checked.fact(checked.callNamed('held.copy'))), ['Derived.copy'])
  assert.deepEqual(checked.targetNames(checked.fact(checked.callInMethod('super.copy', 'copy'))), ['Base.copy'])
  assert.deepEqual(checked.targetNames(checked.fact(checked.callInMethod("super['copy']", 'bracket'))), ['Base.copy'])
  assert.deepEqual(checked.targetNames(checked.fact(checked.callInMethod('super.copy', 'nested'))), ['Base.copy'])
  assert.deepEqual(checked.targetNames(checked.fact(checked.callInMethod('super.copy.call', 'throughCall'))), ['Base.copy'])
  assert.deepEqual(checked.targetNames(checked.fact(checked.callInMethod("super['copy'].apply", 'throughApply'))), ['Base.copy'])

  const explicitCall = checked.fact(checked.callInMethod('super.copy.call', 'throughCall'))!
  assert.equal(explicitCall.operands.explicitThis, true)
  assert.equal(explicitCall.operands.receiver?.getText(checked.file), 'this')
  assert.deepEqual(
    explicitCall.operands.args.map((argument) => argument.getText(checked.file)),
    ['value']
  )

  const explicitApply = checked.fact(checked.callInMethod("super['copy'].apply", 'throughApply'))!
  assert.equal(explicitApply.operands.explicitThis, true)
  assert.equal(explicitApply.operands.receiver?.getText(checked.file), 'this')
  assert.deepEqual(
    explicitApply.operands.args.map((argument) => argument.getText(checked.file)),
    ['value']
  )
})

test('lexical super remains bound through a nested arrow and refuses a dynamic member key', () => {
  const nested = inspect(`
    class Base { copy(value: number) { return value } }
    class Derived extends Base { nested(value: number) { return (() => super.copy(value))() } }
    new Derived().nested(1);
  `)
  assert.deepEqual(nested.targetNames(nested.fact(nested.callInMethod('super.copy', 'nested'))), ['Base.copy'])

  const dynamic = inspect(`
    class Base { copy(value: number) { return value } }
    class Derived extends Base { forward(key: string, value: number) { return super[key](value) } }
    new Derived().forward('copy', 1);
  `)
  assert.equal(dynamic.fact(dynamic.callNamed('super[key]')), null)
})

test('super dispatch refuses a mutated base prototype or an escaped receiver-sensitive base method', () => {
  const mutated = inspect(`
    class Base { copy(value: number) { return value } }
    class Derived extends Base { copy(value: number) { return super.copy(value) } }
    Base.prototype.copy = function(value: number) { return value };
    new Derived().copy(1);
  `)
  assert.equal(mutated.fact(mutated.callNamed('super.copy')), null)

  const escaped = inspect(`
    declare function external(value: unknown): void;
    class Base { last = 0; copy(value: number) { this.last = value; return value } }
    class Derived extends Base { copy(value: number) { return super.copy(value) } }
    external(Base.prototype.copy);
    new Derived().copy(1);
  `)
  assert.equal(escaped.fact(escaped.callNamed('super.copy')), null)
})

test('super dispatch refuses a changed prototype chain and an escaped receiver', () => {
  const prototypeChain = inspect(`
    class Base { copy(value: number) { return value } }
    class Other { copy(value: number) { return value } }
    class Derived extends Base { copy(value: number) { return super.copy(value) } }
    Object.setPrototypeOf(Derived.prototype, Other.prototype);
    new Derived().copy(1);
  `)
  assert.equal(prototypeChain.fact(prototypeChain.callNamed('super.copy')), null)

  const replacement = inspect(`
    declare function externalCopy(value: number): number;
    class Base { copy(value: number) { return value } }
    class Derived extends Base { run(value: number) { return super.copy(value) } }
    const held = new Derived();
    held.copy = externalCopy;
    held.run(1);
  `)
  assert.deepEqual(replacement.targetNames(replacement.fact(replacement.callNamed('super.copy'))), ['Base.copy'])

  const escapedReceiver = inspect(`
    declare function external(value: object): void;
    class Base { last = 0; copy(value: number) { this.last = value; return value } }
    class Derived extends Base { copy(value: number) { return super.copy(value) } }
    const held = new Derived();
    external(held);
    held.copy(1);
  `)
  assert.equal(escapedReceiver.fact(escapedReceiver.callNamed('super.copy')), null)
})

test('super dispatch refuses instance-mediated prototype writes and receiver publication', () => {
  const instancePrototypeWrite = inspect(`
    declare function externalCopy(value: number): number;
    class Base { copy(value: number) { return value } }
    class Derived extends Base { run(value: number) { return super.copy(value) } }
    const held = new Derived();
    Object.getPrototypeOf(Object.getPrototypeOf(held)).copy = externalCopy;
    held.run(1);
  `)
  assert.equal(instancePrototypeWrite.fact(instancePrototypeWrite.callNamed('super.copy')), null)

  const publishesReceiver = inspect(`
    declare function external(value: object): void;
    class Base { copy(value: number) { external(this); return value } }
    class Derived extends Base { run(value: number) { return super.copy(value) } }
    const held = new Derived();
    held.run(1);
  `)
  assert.equal(publishesReceiver.fact(publishesReceiver.callNamed('held.run')), null)

  const ownPrimitiveWrite = inspect(`
    class Base { last = 0; copy(value: number) { this.last = value; return value } }
    class Derived extends Base { run(value: number) { return super.copy(value) } }
    const held = new Derived();
    held.run(1);
  `)
  assert.deepEqual(ownPrimitiveWrite.targetNames(ownPrimitiveWrite.fact(ownPrimitiveWrite.callNamed('held.run'))), ['Derived.run'])
  assert.deepEqual(ownPrimitiveWrite.targetNames(ownPrimitiveWrite.fact(ownPrimitiveWrite.callNamed('super.copy'))), ['Base.copy'])
})
