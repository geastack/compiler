import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { intrinsicDataDefinitionTargetOf } from './intrinsic-data-definition.js'

const planFor = (expression: string, setup = '') => {
  const entry = resolve('test/fixtures/intrinsic-data-definition.ts')
  const source = `export {}; declare const subject: object; ${setup} ${expression};`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  let reference: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText() === 'subject') reference = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(reference)
  return intrinsicDataDefinitionTargetOf(program.getTypeChecker(), reference)
}

test('data definitions retain exact keys, descriptor prototype requirements, and return identity', () => {
  const single = planFor('Object.defineProperty(subject,"id",{value:1})')
  assert.deepEqual(single?.keys, ['id'])
  assert.deepEqual(single?.descriptorPrototypeKeys, ['writable', 'get', 'set', 'enumerable', 'configurable'])
  assert.equal(single?.returnsTarget, true)
  const bulk = planFor('Object.defineProperties(subject,{id:{value:1},position:{value:{x:2}}})')
  assert.deepEqual(bulk?.keys, ['id', 'position'])
  assert.equal(bulk?.returnsTarget, true)
  const reflected = planFor('Reflect.defineProperty(subject,"id",{value:1})')
  assert.equal(reflected?.returnsTarget, false)
  assert.equal(reflected?.owner, 'Reflect')
  assert.deepEqual(planFor('Object.defineProperty(subject,0,{__proto__:null,value:1})')?.descriptorPrototypeKeys, [])
})

test('accessor descriptors, coercive keys, and unknown descriptor properties remain open', () => {
  for (const expression of [
    'Object.defineProperty(subject,"id",{get(){return 1}})',
    'Object.defineProperty(subject,"id",{get value(){return 1}})',
    'Object.defineProperty(subject,"id",{...unknownDescriptor})',
    'Object.defineProperty(subject,unknownKey,{value:1})',
    'Object.defineProperty(subject,"id",{[unknownKey]:1})',
    'Object.defineProperty(subject,"id",{__proto__:unknownDescriptor,value:1})',
    'Object.defineProperties(subject,{get id(){return {value:1}}})',
    'Object.defineProperties(subject,{id:unknownDescriptor})',
    'Object.defineProperty(subject,"constructor",{value:1})'
  ])
    assert.equal(planFor(expression, 'declare const unknownDescriptor: any; declare const unknownKey: any;'), null, expression)
})

test('structurally compatible and shadowed namespaces do not authenticate intrinsic calls', () => {
  assert.equal(
    planFor('Object.defineProperty(subject,"id",{value:1})', 'declare const Object: {defineProperty(...args:unknown[]):object};'),
    null
  )
  assert.equal(planFor('other.Object.defineProperty(subject,"id",{value:1})', 'declare const other: typeof globalThis;'), null)
  assert.equal(planFor('alias.defineProperty(subject,"id",{value:1})', 'const alias = Object;'), null)
})
