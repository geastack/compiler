import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'

/**
 * node-compat's `emit(name, ...args: readonly unknown[])`: when arrays of the
 * rest's type fall back to dynamic dispatch elsewhere in the program (here, a
 * Proxy over one), the rest parameter still receives the fresh ordinary Array
 * the call's argument packing builds. Its binding and its call frame are one
 * carrier, so the ABI projection finds no disagreement.
 */
const directory = resolve('test/fixtures/rest-packed-frame')

test('a rest parameter binds the array its call frame packs, even when its array type falls back elsewhere', () => {
  const result = compile({
    rootFileNames: [resolve(directory, 'proxied-rest.ts')],
    projectFileName: null,
    javaScriptSources: true,
    dynamicFallback: true
  })
  assert.deepEqual(
    result.abiBlockers.map((blocker) => blocker.reason),
    []
  )
  assert.notEqual(result.certificate, null)
})
