import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { noPluginCapabilities, type CompilerPlugin } from './model.js'

test('an installed host constant survives another feature declaring that global absent', () => {
  const entry = resolve('test/fixtures/global-this-host-builtin.ts')
  const feature: CompilerPlugin = {
    name: 'absence-feature',
    instantiate: () => ({
      producers: () => [],
      lower: () => false,
      capabilities: { ...noPluginCapabilities, absentGlobals: new Set(['hostToken']) }
    })
  }
  const provider: CompilerPlugin = {
    name: 'constant-provider',
    instantiate: () => ({
      producers: () => [],
      lower: () => false,
      capabilities: { ...noPluginCapabilities, nativeConstants: new Map([['hostToken', '"supplied"']]) }
    })
  }
  for (const plugins of [
    [provider, feature],
    [feature, provider]
  ]) {
    const result = compile({
      rootFileNames: [entry],
      projectFileName: null,
      plugins,
      sourceOverlay: new Map([[entry, 'export {}; declare const hostToken: string; console.log(hostToken);']])
    })
    assert.equal(result.diagnostics.clean, true)
    assert.ok(result.source)
    assert.match(result.source, /"supplied"/)
    assert.doesNotMatch(result.source, /unreachableValue/)
  }
})
