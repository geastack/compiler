import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { adoptGeaPackage } from '../dist/plugins/gea/host.js'

const root = resolve(import.meta.dirname, '..')
const fixture = resolve(root, 'test/fixtures/gea-host-namespace-members')
adoptGeaPackage(resolve(root, '../core/packages/geatsc-plugin-gea/dist/index.js'))

// A namespace path's member call renders the host's free function; the path
// itself is never a value, and no logical receiver crosses the call.
test('calls through installed host namespace paths lower to the host spellings', () => {
  const result = compile({ rootFileNames: [resolve(fixture, 'index.ts')], projectFileName: resolve(fixture, 'tsconfig.json') })
  assert.ok(result.certificate, JSON.stringify({ diagnostics: result.diagnostics.diagnostics, refusals: result.refusals }))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source, /gea::host::navigator\.bluetooth\.keyboard\.tap\(/)
  assert.match(result.source, /gea::host::navigator\.bluetooth\.keyboard\.up\(/)
  assert.match(result.source, /gea::host::navigator\.bluetooth\.enabled\(/)
  assert.match(result.source, /gea::host::Storage\.getItem\(/)
  assert.match(result.source, /gea::host::Storage\.setItem\(/)
  assert.match(result.source, /gea::host::Storage\.removeItem\(/)
})
