import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { isOpenTypeForm } from './open-type-form.js'

const inspect = (source: string) => {
  const file = resolve('test/fixtures/open-type-form.ts')
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true }
  const host = ts.createCompilerHost(options)
  const get = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    resolve(name) === resolve(file) ? ts.createSourceFile(name, source, version, true) : get(name, version, onError, fresh)
  const program = ts.createProgram([file], options, host)
  const checker = program.getTypeChecker()
  const types = new Map<string, ts.Type>()
  const walk = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) types.set(node.name.text, checker.getTypeAtLocation(node))
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const signature = checker.getSignatureFromDeclaration(node)
      if (signature) types.set(node.name.getText(), signature.getReturnType())
    }
    ts.forEachChild(node, walk)
  }
  walk(program.getSourceFile(file)!)
  return (name: string): boolean => {
    const type = types.get(name)
    assert.ok(type, name)
    return isOpenTypeForm(type)
  }
}

test('polymorphic receivers have concrete carriers without closing generic type arguments', () => {
  const open = inspect(`
    class Renderer { concrete(): this { return this } list(): this[] { return [this] } }
    interface View { interfaceSelf(): this }
    class Generic<T> { genericSelf(): this { return this } }
    function consume<T extends Renderer, U>(bounded: T, unresolved: Generic<U>, instantiated: Generic<number>) {}
  `)
  assert.equal(open('concrete'), false)
  assert.equal(open('instantiated'), false)
  assert.equal(open('interfaceSelf'), false)
  assert.equal(open('list'), false)
  assert.equal(open('genericSelf'), true)
  assert.equal(open('bounded'), true)
  assert.equal(open('unresolved'), true)
})

test('unreduced conditional, indexed, keyof and nested generic forms remain open', () => {
  const open = inspect(`
    function consume<T, K extends keyof T>(conditional: T extends string ? number : boolean,
      indexed: T[K], keys: keyof T, array: T[], union: T | number, closed: number | string) {}
  `)
  for (const name of ['conditional', 'indexed', 'keys', 'array', 'union']) assert.equal(open(name), true, name)
  assert.equal(open('closed'), false)
})
