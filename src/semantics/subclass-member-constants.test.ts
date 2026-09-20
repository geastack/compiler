import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createSubclassMemberOverlayTransform } from './subclass-member-overlay-transform.js'
import { createProgram, defaultCompilerOptions } from './program.js'

const directory = resolve('test/fixtures/subclass-member-constants')
const base = resolve(directory, 'base.js')
const child = resolve(directory, 'child.js')

test('a subclass member typed by package constants is stated on the base as their primitive domain', () => {
  const result = createProgram({
    rootFileNames: [child],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] },
    sourceTransforms: [createSubclassMemberOverlayTransform((file) => readFileSync(file, 'utf8'))]
  })
  const file = result.program.getSourceFile(base)
  assert.ok(file)
  const declaration = file.statements.find(ts.isClassDeclaration)
  assert.ok(declaration)
  const combine = result.checker.getTypeAtLocation(declaration).getProperty('combine')
  assert.ok(combine)
  assert.equal(result.checker.typeToString(result.checker.getTypeOfSymbolAtLocation(combine, declaration)), 'number | undefined')
  const reader = result.program.getSourceFile(child)?.statements.find(ts.isFunctionDeclaration)
  const read = reader?.body?.statements.find(ts.isReturnStatement)?.expression
  assert.ok(read)
  assert.equal(result.checker.typeToString(result.checker.getTypeAtLocation(read)), 'number | undefined')
})
