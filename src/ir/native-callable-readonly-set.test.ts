import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile, type CompilationResult } from '../compiler.js'
import type { FunctionId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import { allOperationsOf, type IrBody, type IrNonTerminatorOperation, type IrOperation } from './model.js'
import { nativeCallableDataSlotInputOf, type PublishNativeCallableDataSlotsInput } from './native-callable-data-slots.js'
import { nativeCallableReadonlySetMatches, nativeCallableReadonlySetsOf as readonlySetsOf } from './native-callable-readonly-set.js'
import { coreHostMembers } from '../targets/cpp/host/host-members.js'

const entry = resolve('test/runtime/property-helper-date-prototype-length.runtime.js')
const compileSource = (source: string, strict = true) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve(strict ? 'test/runtime/tsconfig.json' : 'test/runtime/native-callable-readonly-set-sloppy.tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, `// @ts-nocheck\n${strict ? 'export {};\n' : ''}${source}`]])
  })
// Each query derives its one flow from exactly the bodies it is handed.
const nativeCallableReadonlySetsOf = (input: PublishNativeCallableDataSlotsInput) => readonlySetsOf(nativeCallableDataSlotInputOf(input))
const inputOf = (result: CompilationResult): PublishNativeCallableDataSlotsInput => ({
  nativeCallableData: result.representations.nativeCallableData,
  programConversions: null,
  graph: result.graph,
  bodies: new Map((result.irBodies ?? []).map((body) => [body.owner, body])),
  placements: result.projection.placements,
  classes: result.projection.classes,
  deriver: result.representations.deriver,
  conversions: result.conversionCensus,
  calleeRendering: {
    hostMembers: coreHostMembers,
    graph: result.graph,
    plan: result.representations.plan,
    deriver: result.representations.deriver,
    placements: result.projection.placements,
    classes: result.projection.classes,
    hostMethodAliasDeclarations: new Set()
  }
})
const operationsOf = (result: CompilationResult): IrOperation[] =>
  (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))

const source = `
  function value() { return 7 }
  function attempt(obj, key) { obj[key] = value() }
  attempt(Date.prototype.getTime, 'name')
`

test('a stock readonly Set evaluates its native RHS and preserves strict rejection without payload boxing', () => {
  const result = compileSource(source)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const sets = operationsOf(result).filter((one) => one.kind === 'set' && one.nativeCallableReadonlySet !== undefined)
  assert.equal(sets.length, 1)
  const set = sets[0]!
  assert.equal(set.kind, 'set')
  if (set.kind !== 'set') return
  assert.equal(set.strict, true)
  assert.equal(set.value.representation.kind, 'scalar')
  assert.equal(set.nativeCallableDataWrite, undefined)
  assert.equal(set.nativeCallableDataSlot, undefined)
  assert.deepEqual(set.conversionRecipes, [], 'a rejected Set cannot retain a payload installation or boxing recipe')
  assert.deepEqual(set.nativeCallableReadonlySet!.keys, ['name'])
  assert.match(result.source!, /Cannot assign to read-only Function own property/)
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet|gea::callableNativeDataSet/)
  assert.equal(nativeCallableReadonlySetsOf(inputOf(result)).has(set), true)
})

test('sloppy rejected Set performs the same evaluation without manufacturing a strict exception', () => {
  const result = compileSource(source, false)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  const set = operationsOf(result).find((one) => one.kind === 'set' && one.nativeCallableReadonlySet !== undefined)
  assert.ok(set?.kind === 'set')
  assert.equal(set.strict, false)
  assert.deepEqual(set.conversionRecipes, [], 'sloppy rejection evaluates the RHS without installing or boxing it')
  assert.doesNotMatch(result.source!, /Cannot assign to read-only Function own property|gea::callableDynamicSet|gea::callableNativeDataSet/)
})

test('closed unentered callers do not hide the actual stock key or turn its readonly rejection into payload storage', () => {
  const result = compileSource(`
    /** @param {string | symbol} key */
    function attempt(obj, key) { obj[key] = 7 }
    function unused() { attempt(Date.prototype.getTime, Symbol()) }
    function verify(obj, key) { attempt(obj, key) }
    verify(Date.prototype.getTime, 'name')
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const sets = operationsOf(result).filter((one) => one.kind === 'set' && one.nativeCallableReadonlySet !== undefined)
  assert.equal(sets.length, 1)
  const set = sets[0]!
  if (set.kind !== 'set') return
  assert.deepEqual(set.nativeCallableReadonlySet!.keys, ['name'])
  assert.equal(nativeCallableReadonlySetsOf(inputOf(result)).has(set), true)
  assert.deepEqual(set.conversionRecipes, [])
  assert.doesNotMatch(result.source!, /gea::callableDynamicSet|gea::callableNativeDataSet/)
})

test('unentered exclusion does not authenticate a public union of incompatible native receiver frames', () => {
  const result = compileSource(`
    /** @param {string | symbol} key */
    function attempt(obj, key) { obj[key] = 7 }
    function unused() { attempt(() => 7, Symbol()) }
    function verify(obj, key) { attempt(obj, key) }
    verify(Date.prototype.getTime, 'name')
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.source, null)
  assert.equal(
    result.refusals.some((refusal) => refusal.key === 'property-access:tagged-union:set:true'),
    true
  )
})

test('readonly receipt replay refuses unrelated SSA, stock source, entry and strictness substitutions', () => {
  const result = compileSource(source)
  const input = inputOf(result)
  const expected = nativeCallableReadonlySetsOf(input)
  const set = [...expected.keys()][0]
  assert.ok(set)
  const receipt = expected.get(set)!
  assert.equal(nativeCallableReadonlySetMatches(receipt, receipt), true)
  assert.equal(nativeCallableReadonlySetMatches(receipt, undefined), false)
  for (const forged of [
    { ...receipt, key: receipt.value },
    { ...receipt, receiver: { ...receipt.receiver, value: 'unrelated-receiver' as IrValueId } },
    { ...receipt, value: receipt.receiver },
    { ...receipt, sources: receipt.sources.map((one) => ({ ...one, member: 'setTime' })) },
    { ...receipt, entries: [] },
    { ...receipt, entry: { ...receipt.entry, restFrom: receipt.entry.restFrom === null ? 0 : null } }
  ])
    assert.equal(nativeCallableReadonlySetMatches(receipt, forged), false)
  for (const changed of [
    { ...set, key: set.value },
    { ...set, receiver: { ...set.receiver, value: 'unrelated-receiver' as IrValueId } },
    { ...set, strict: !set.strict }
  ]) {
    const bodies: ReadonlyMap<PhysicalBodyId, IrBody> = new Map<PhysicalBodyId, IrBody>(
      [...input.bodies].map(([id, body]): [PhysicalBodyId, IrBody] => [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              {
                ...block,
                operations: block.operations.map((one): IrNonTerminatorOperation => (one === set ? changed : one))
              }
            ])
          )
        }
      ])
    )
    assert.equal(nativeCallableReadonlySetsOf({ ...input, bodies }).has(changed), false)
  }
  const semanticId = input.graph.results.get(set.lineage)
  const semantic = semanticId === undefined ? undefined : input.graph.operations.get(semanticId)
  assert.ok(semantic?.family === 'property' && semantic.nativeCallableReadonlySet !== undefined)
  const operations = new Map(input.graph.operations)
  operations.set(semantic.id, {
    ...semantic,
    nativeCallableReadonlySet: { ...semantic.nativeCallableReadonlySet, entries: [] }
  })
  assert.equal(
    nativeCallableReadonlySetsOf({ ...input, graph: { ...input.graph, operations } }).has(set),
    false,
    'omitting the source entry cannot authenticate a readonly descriptor on a called formal'
  )
})

test('prior redefinition and same-shaped unknown owners retain the ordinary storage authority requirement', () => {
  for (const before of [`Object.defineProperty(original, 'name', { value: 1, writable: true })`, `delete original.name`]) {
    const result = compileSource(`function attempt(obj, key) { obj[key] = 7 }
      const original = Date.prototype.getTime
      ${before}
      attempt(original, 'name')`)
    assert.equal(
      operationsOf(result).some((one) => one.kind === 'set' && one.nativeCallableReadonlySet !== undefined),
      false
    )
  }
})

test('an unrelated active body with the same physical ABI cannot borrow the exact source entry receipt', () => {
  const result = compileSource(source)
  const input = inputOf(result)
  const receipts = nativeCallableReadonlySetsOf(input)
  const set = [...receipts.keys()][0]
  assert.ok(set)
  const receipt = receipts.get(set)!
  const call = operationsOf(result).find((one) => one.kind === 'call' && one.lineage === receipt.entries[0])
  assert.ok(call?.kind === 'call' && call.closedCallee?.kind === 'exact')
  if (call.kind !== 'call' || call.closedCallee?.kind !== 'exact') return
  const functionId = call.closedCallee.functionId
  const body = [...input.bodies.values()].find((one) => one.sourceOwner === functionId && one.abi !== null)
  assert.ok(body)
  const unrelated = 'unrelated-entry-function' as FunctionId
  const unrelatedBody = 'unrelated-entry-body' as PhysicalBodyId
  const changed = { ...call, closedCallee: { ...call.closedCallee, functionId: unrelated } }
  const bodies = new Map<PhysicalBodyId, IrBody>(
    [...input.bodies].map(([id, one]): [PhysicalBodyId, IrBody] => [
      id,
      {
        ...one,
        blocks: new Map(
          [...one.blocks].map(([blockId, block]) => [
            blockId,
            { ...block, operations: block.operations.map((operation) => (operation === call ? changed : operation)) }
          ])
        )
      }
    ])
  )
  bodies.set(unrelatedBody, { ...body, owner: unrelatedBody, sourceOwner: unrelated, blocks: new Map() })
  assert.equal(nativeCallableReadonlySetsOf({ ...input, bodies }).has(set), false)
})

test('the real Date property helpers retain readonly Set receipts under their actual complete frames', () => {
  for (const file of ['property-helper-date-prototype-length.runtime.js', 'property-helper-date-prototype-name.runtime.js']) {
    const result = compile({
      rootFileNames: [resolve('test/runtime', file)],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      closedScriptScope: true,
      includeIr: true
    })
    assert.equal(result.diagnostics.clean, true, file)
    assert.notEqual(result.source, null, `${file}: ${JSON.stringify(result.refusals)}`)
    assert.equal(
      operationsOf(result).some((one) => one.kind === 'set' && one.nativeCallableReadonlySet !== undefined),
      true,
      file
    )
    assert.equal(
      operationsOf(result).some(
        (one) => one.kind === 'set' && one.nativeCallableReadonlySet !== undefined && one.key.representation.kind === 'tagged-union'
      ),
      true,
      `${file}: the source literal receipt must authenticate the actual public String-or-Symbol key slot`
    )
  }
})
