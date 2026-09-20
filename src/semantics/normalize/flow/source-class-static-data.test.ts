import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'

/** Whether `Subject`'s constructor stays closed when its statics are written as `statics` says. */
const keeps = (statics: string, js = false, members = ''): boolean => {
  const entry = resolve(`test/fixtures/source-class-static-data.${js ? 'js' : 'ts'}`)
  const source = `
    class Subject { ${members} }
    ${statics}
    const value = new Subject();
    const image = Subject.DEFAULT_IMAGE;`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [], allowJs: js, checkJs: js, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, source, version, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [program.getSourceFile(entry)!], wholeProgram)
  const owner = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Subject')!
  const type = checker.getTypeAtLocation(owner)
  assert.ok(type.isClassOrInterface())
  return classConstructorKeepsInstanceOf(checker, flow, type)
}

test('a static is data by the values written to it, not by its declared type', () => {
  // three's `Texture.DEFAULT_IMAGE`: declared as an image constructor, only ever written `null`.
  assert.equal(keeps('/** @type {?(new () => object)} */ Subject.DEFAULT_IMAGE = null;', true), true)
  assert.equal(keeps('', false, 'static DEFAULT_IMAGE: (new () => object) | null = null'), true)
  assert.equal(keeps('', false, 'static DEFAULT_IMAGE: (() => void) | null = () => {}'), false)
  assert.equal(keeps('/** @type {number} */ Subject.DEFAULT_IMAGE = 1; Subject.DEFAULT_IMAGE = 2;', true), true)
})

test('a callable, opaque or unenumerated static store keeps the constructor open', () => {
  for (const statics of [
    // A function or class value, called as `Subject.DEFAULT_IMAGE()`, receives the constructor as `this`.
    'Subject.DEFAULT_IMAGE = null; Subject.DEFAULT_IMAGE = function () { globalThis.external(this) };',
    'Subject.DEFAULT_IMAGE = class {};',
    // Opaque values may be functions. (`globalThis.external` is DOM's data object; `opaqueHook` is untyped.)
    'Subject.DEFAULT_IMAGE = globalThis.opaqueHook;',
    '/** @type {object} */ const opaque = globalThis.opaqueHook; Subject.DEFAULT_IMAGE = opaque;',
    // Stores this layer cannot enumerate.
    'Subject.DEFAULT_IMAGE = null; Subject[globalThis.externalKey] = () => 0;',
    'Subject.DEFAULT_IMAGE = null; Object.assign(Subject, { DEFAULT_IMAGE: () => 0 });',
    'Subject.DEFAULT_IMAGE = null; Object.defineProperty(Subject, "DEFAULT_IMAGE", { value: () => 0 });',
    'Subject.DEFAULT_IMAGE = null; Subject.DEFAULT_IMAGE ||= () => 0;'
  ])
    assert.equal(keeps(statics, true), false, statics)
})
