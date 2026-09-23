import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

/**
 * A script's top-level `function`/`var` is an own property of the global
 * object, so once the mutation census cannot place a write through
 * `globalThis` its bare read has two writers. A CommonJS module's top-level
 * declarations are the module's own -- the binder bound them as file locals --
 * and no write through the global object reaches them.
 */
const directory = resolve('test/fixtures/commonjs-top-level-declarations')
const redefinition = "a script's global var is redefined through the global object"

const redefinitionRootsOf = (file: string): readonly string[] =>
  compile({ rootFileNames: [resolve(directory, file)], projectFileName: null, javaScriptSources: true, dynamicFallback: true })
    .diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root' && diagnostic.message.includes(redefinition))
    .map((diagnostic) => diagnostic.message)

test('a CommonJS module reads its own top-level function under an unplaced global write', () => {
  assert.deepEqual(redefinitionRootsOf('module.js'), [])
})

test('a script still refuses the same read, because its declaration is a global-object property', () => {
  assert.notDeepEqual(redefinitionRootsOf('script.js'), [])
})
