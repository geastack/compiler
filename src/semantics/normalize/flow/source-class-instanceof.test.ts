import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'

const closed = (members = '', extra = '', base = '') => {
  const entry = resolve('test/fixtures/source-class-instanceof.ts')
  const source = `${base}
    class Subject ${base ? 'extends Parent' : ''} { ${members} }
    const value = new Subject();
    const result = value instanceof Subject;
    ${extra}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const owner = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Subject')!
  const type = checker.getTypeAtLocation(owner)
  assert.ok(type.isClassOrInterface())
  return classConstructorKeepsInstanceOf(checker, flow, type)
}

test('only a closed ordinary source constructor family admits RHS instanceof observations', () => {
  assert.equal(closed(), true)
  assert.equal(closed('', '', 'class Parent {}'), true)
  assert.equal(closed('static ["label"] = 1'), true)
  assert.equal(closed('', 'globalThis.external(Subject);'), false)
  assert.equal(
    closed('', 'globalThis.external(value);'),
    true,
    'this predicate inventories constructors; receiver closure is a separate proof'
  )
})

test('own and inherited custom or unresolved static symbol hooks keep instanceof effectful', () => {
  for (const members of [
    'static [Symbol.hasInstance](value: unknown) { globalThis.external(this); return true }',
    'static get [Symbol.hasInstance]() { globalThis.external(this); return () => true }',
    'static [globalThis.externalKey] = () => true'
  ]) {
    assert.equal(closed(members), false)
    assert.equal(closed('', '', `class Parent { ${members} }`), false)
  }
})

test('constructor prototype mutations and aliases retain their escape boundary', () => {
  for (const extra of [
    'Object.setPrototypeOf(Subject, globalThis.external);',
    'Reflect.setPrototypeOf(Subject, globalThis.external);',
    'Object.defineProperty(Subject, Symbol.hasInstance, { value: () => true });',
    'Subject.prototype.hook = globalThis.external;',
    'const alias = Subject; globalThis.external(alias);'
  ])
    assert.equal(closed('', extra), false, extra)
  assert.equal(closed('', 'Object.setPrototypeOf(Parent, globalThis.external);', 'class Parent {}'), false)
})

test('the intrinsic inherited hasInstance hook cannot be changed through a Function.prototype alias', () => {
  const prototype = Object.getPrototypeOf(function () {})
  const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.hasInstance)!
  assert.equal(prototype, Function.prototype)
  assert.equal(descriptor.writable, false)
  assert.equal(descriptor.configurable, false)
  assert.equal(
    Reflect.set(prototype, Symbol.hasInstance, () => false),
    false
  )
  assert.equal(Reflect.deleteProperty(prototype, Symbol.hasInstance), false)
  assert.equal(Object.getOwnPropertyDescriptor(prototype, Symbol.hasInstance)!.value, descriptor.value)
})
