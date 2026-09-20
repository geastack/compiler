import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { createReceiverResolver } from './structural-receiver.js'

const source = ts.createSourceFile(
  'static-receivers.ts',
  `class Base {
    static value = 7
    static plain(value: number) { return value }
    static direct() { return this.value }
    static lexical() { return () => this.value }
    static defaulted(value = this.value) { return value }
    static nested() { return function () { return this } }
    static computed() { return { [this.value]() { return 1 } } }
    static nestedClass() { return class extends this {} }
    static get plainGetter() { return 1 }
    static get receiverGetter() { return this.value }
    static declared(value: number): number
    static declared(value: number) { return value }
  }
  class Child extends Base {
    static inherited() { return super.direct() }
  }`,
  ts.ScriptTarget.Latest,
  true
)
const host = ts.createCompilerHost({ noLib: true })
host.getSourceFile = (name) => (resolve(name) === resolve(source.fileName) ? source : undefined)
const program = ts.createProgram([source.fileName], { noLib: true }, host)
const checker = program.getTypeChecker()
const resolver = createReceiverResolver(checker, (node) => checker.getTypeAtLocation(node))
const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members])

test('static receiver analysis distinguishes implementation effects from method syntax', () => {
  for (const name of ['plain', 'nested', 'plainGetter']) {
    const member = members.find((node) => node.name?.getText(source) === name)
    assert.ok(member && (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)))
    assert.equal(resolver.implicitReceiverOf(member), null, name)
  }
  for (const name of ['direct', 'lexical', 'defaulted', 'computed', 'nestedClass', 'receiverGetter', 'inherited']) {
    const member = members.find((node) => node.name?.getText(source) === name)
    assert.ok(member && (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)))
    assert.notEqual(resolver.implicitReceiverOf(member), null, name)
  }
})

test('an absent static implementation cannot prove its receiver unused', () => {
  const overload = members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'declared' && !node.body)
  assert.ok(overload && ts.isMethodDeclaration(overload))
  assert.notEqual(resolver.implicitReceiverOf(overload), null)
})
