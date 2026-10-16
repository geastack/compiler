import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import { classConstructorBindingUsesAreClosed, classConstructorKeepsInstanceOf } from './member-call-forwarding.js'
import { sourceRawConstructorAllocationOf } from './source-raw-constructor-entry.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-raw-constructor-entry.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, 'export {}\n' + source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host),
    checker = program.getTypeChecker(),
    file = program.getSourceFile(entry)!
  const files = program.getSourceFiles(),
    flow = indexValueFlow(checker, files, wholeProgram)
  attachStatedModuleSet(flow, { files, entries: [file], reachable: wholeProgram })
  const owner = flow.classDeclarations.find((one) => one.name?.text === 'Subject')!
  const type = checker.getTypeAtLocation(owner)
  assert.ok(type.isClassOrInterface())
  let receiver: ts.ThisExpression | undefined
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword && !receiver) receiver = node as ts.ThisExpression
    ts.forEachChild(node, visit)
  }
  visit(owner)
  const raw = receiver ? sourceRawConstructorAllocationOf(checker, flow, receiver) : null
  return {
    entry: classConstructorBindingUsesAreClosed(checker, flow, type),
    result: classConstructorKeepsInstanceOf(checker, flow, type),
    raw
  }
}

test('ordinary construction retains both entry and result contracts', () => {
  const proof = inspect('class Subject { constructor() { void this } } new Subject()')
  assert.equal(proof.entry, true)
  assert.equal(proof.result, true)
  assert.equal(proof.raw?.kind, 'base-constructor-initial-allocation')
  assert.deepEqual(
    proof.raw?.entries.map((one) => one.newTarget.name?.text),
    ['Subject']
  )
})

test('returned Proxy leaves the result guard strict and its separate ownership obligation open', () => {
  const proof = inspect('class Subject { constructor() { return new Proxy(this, {}) } } class Child extends Subject {} new Child()')
  assert.equal(proof.entry, true)
  assert.equal(proof.result, false)
  assert.equal(proof.raw, null, 'no raw/result alias may bypass unsupported Proxy result ownership')
})

test('constructor escape, foreign newTarget and prototype exchange refuse entry inventory', () => {
  for (const extra of [
    'declare function expose(value: unknown): void; expose(Subject)',
    'declare const foreign: any; Reflect.construct(Subject, [], foreign)',
    'declare const foreign: any; Object.setPrototypeOf(Subject.prototype, foreign)'
  ]) {
    const proof = inspect(`class Subject { constructor() { return new Proxy(this, {}) } } new Subject(); ${extra}`)
    assert.equal(proof.entry, false, extra)
    assert.equal(proof.raw, null, extra)
  }
})

test('derived this may be the super constructor result and is not a raw allocation', () => {
  const proof = inspect(
    'class Parent { constructor() { return new Proxy(this,{}) } } class Subject extends Parent { constructor() { super(); void this } } new Subject()'
  )
  assert.equal(proof.raw, null)
})

test('an exposed entry constructor or a never-entered constructor supplies no raw allocation proof', () => {
  assert.equal(inspect('export class Subject { constructor() { void this } } new Subject()').raw, null)
  assert.equal(inspect('class Subject { constructor() { void this } }').raw, null)
})

test('an escaped instance can expose its constructor without a spelled class-binding reference', () => {
  const proof = inspect(
    'declare function expose(value: unknown): void; class Subject { constructor() { void this } } const value = new Subject(); expose(value)'
  )
  assert.equal(proof.raw, null)
})
