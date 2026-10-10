import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { functionReflectionDemandOf } from './function-reflection-demand.js'

test('a Function used as an unknown logical receiver retains its observable metadata', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/native-function-logical-receiver.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.source !== null, true, JSON.stringify(result.refusals))
  assert.deepEqual(functionReflectionDemandOf(result.irBodies ?? []), { facts: true, sources: true })
  assert.match(result.source ?? '', /entryWithFacts</)
})

test('name and length reflection retain facts without original function source', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/function-metadata-does-not-retain-source.runtime.js')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.source !== null, true, JSON.stringify(result.refusals))
  assert.deepEqual(functionReflectionDemandOf(result.irBodies ?? []), { facts: true, sources: false })
  assert.doesNotMatch(result.source ?? '', /return x \+ 7331/)
})

test('ordinary invocation does not retain Function reflection metadata', () => {
  const entry = resolve('test/runtime/unobserved-function-reflection.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, 'export {}; function answer(): number { return 7 }; console.log(answer())']])
  })
  assert.equal(result.source !== null, true, JSON.stringify(result.refusals))
  assert.deepEqual(functionReflectionDemandOf(result.irBodies ?? []), { facts: false, sources: false })
})
