import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'
import { cppDynamicArgumentHostParameters } from '../../targets/cpp/host/dynamic-argument-members.js'

const fixture = resolve('test/runtime/dynamic-host-argument-waiver-probe.ts')

const compileSource = (source: string) =>
  compile({ rootFileNames: [fixture], projectFileName: null, sourceOverlay: new Map([[fixture, source]]) })

test('dynamic host waivers are argument-position capabilities', () => {
  assert.ok([...cppDynamicArgumentHostParameters].every((key) => /:argument:(?:\d+|\*)$/.test(key)))
  assert.equal(cppDynamicArgumentHostParameters.has('ObjectConstructor.defineProperty:argument:1'), true)
  assert.equal(cppDynamicArgumentHostParameters.has('ObjectConstructor.defineProperty:argument:2'), false)
})

test('a dynamic Object.defineProperty descriptor cannot mint a certificate', () => {
  const result = compileSource(`
    function install(target: { fixed: number }, descriptor: any) {
      Object.defineProperty(target, 'extra', descriptor)
    }
    install({ fixed: 1 }, { value: 2 })
  `)

  assert.equal(result.certificate, null)
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  // Refused at certification, by the same key the printer would have refused
  // it under -- never left for the printer to discover on a certified program.
  assert.ok(
    result.refusals.some((row) => row.stage === 'certify' && row.key === 'host-member-call:ObjectConstructor.defineProperty'),
    JSON.stringify(result.refusals)
  )
})

test('a dynamic Object.defineProperty key keeps its exact host waiver', () => {
  const result = compileSource(`
    function install(target: { fixed: number }, key: any) {
      Object.defineProperty(target, key, { value: 2, writable: true, enumerable: true, configurable: true })
    }
    install({ fixed: 1 }, 'extra')
  `)

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source ?? '', /gea::host::toPropertyKey\(gea_arg_1\)/)
})

test('Object.defineProperties has no dynamic descriptor-map waiver', () => {
  assert.equal(
    [...cppDynamicArgumentHostParameters].some((key) => key.startsWith('ObjectConstructor.defineProperties:')),
    false
  )
  const result = compileSource(`
    function install(target: { fixed: number }, descriptors: any) {
      Object.defineProperties(target, descriptors)
    }
    install({ fixed: 1 }, { extra: { value: 2 } })
  `)

  assert.equal(result.certificate, null)
  assert.deepEqual(result.emissionRefusals, [])
  // No host member table claims `defineProperties` (its closed-literal form is
  // lowered away by a source transform), so the member read itself is the
  // capability the manifest lacks.
  assert.ok(
    result.refusals.some((row) => row.stage === 'certify' && row.key === 'host-invocation:ObjectConstructor.defineProperties'),
    JSON.stringify(result.refusals)
  )
})
