import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'

// three's `Backend` builds `timestampQueryPool` as `{ [ TimestampQuery.RENDER
// ]: null, [ TimestampQuery.COMPUTE ]: null }`, with `TimestampQuery` imported
// from `constants.js`, where its JSDoc states every member as `string`. The
// keys are one value each only by the whole-program proof that no module
// rewrites the constants literal, which needs the module set stated -- the
// runtime suite's single-module program cannot pin it.
const constants = resolve('test/runtime/computed-constant-key.constants.overlay.js')
const backend = resolve('test/runtime/computed-constant-key.backend.overlay.js')
const overlay = new Map([
  [
    constants,
    [
      '// @ts-nocheck',
      '/**',
      ' * @type {ConstantsTimestampQuery}',
      ' * @constant',
      ' */',
      'export const TimestampQuery = {',
      "\tCOMPUTE: 'compute',",
      "\tRENDER: 'render'",
      '};',
      '/**',
      ' * @typedef {Object} ConstantsTimestampQuery',
      ' * @property {string} COMPUTE',
      ' * @property {string} RENDER',
      ' **/',
      ''
    ].join('\n')
  ],
  [
    backend,
    [
      '// @ts-nocheck',
      "import { TimestampQuery } from './computed-constant-key.constants.overlay.js';",
      'class Pool { constructor( n ) { this.n = n; } }',
      'class Backend {',
      '\tconstructor() {',
      '\t\t/** @type {{render: ?Pool, compute: ?Pool}} */',
      '\t\tthis.timestampQueryPool = {',
      '\t\t\t[ TimestampQuery.RENDER ]: null,',
      '\t\t\t[ TimestampQuery.COMPUTE ]: null',
      '\t\t};',
      '\t}',
      '}',
      'const b = new Backend();',
      'b.timestampQueryPool.render = new Pool( 3 );',
      'console.log( b.timestampQueryPool.render.n, b.timestampQueryPool.compute );',
      ''
    ].join('\n')
  ]
])

test('a computed key read off an imported constants literal defines one static field', () => {
  const result = compile({ rootFileNames: [backend], javaScriptSources: true, statedModuleSet: true, sourceOverlay: overlay })
  assert.deepEqual(
    result.refusals.map((refusal) => `${refusal.stage} ${refusal.key ?? ''} ${refusal.reason}`),
    []
  )
})

test('a constants literal some module rewrites leaves the key computed', () => {
  const rewritten = new Map(overlay)
  rewritten.set(backend, `${overlay.get(backend)}TimestampQuery.RENDER = 'other';\n`)
  const result = compile({ rootFileNames: [backend], javaScriptSources: true, statedModuleSet: true, sourceOverlay: rewritten })
  assert.ok(
    result.refusals.some((refusal) => refusal.key === 'property-access:record:define-own-property:true'),
    JSON.stringify(result.refusals.map((refusal) => refusal.key))
  )
})
