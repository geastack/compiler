import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createIrBodyBuilder } from './build.js'
import type { IrOperand, IrOperation } from './model.js'
import { noNormalCallCompletionOf } from './no-normal-call-completion.js'
import { resultOfIrOperation } from './queries.js'

const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const lineage = (id: string) => id as SemanticResultId
const operand = (value: IrOperand['value'], representation: Representation): IrOperand => ({ value, representation })
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const fixture = (effect: 'call' | 'arithmetic' | false = false, cycle = false) => {
  const conversions = censusOf()
  const abi: CallableAbi = {
    receiver: null,
    restFrom: null,
    parameters: [{ value: dynamic, passing: 'by-value', ownership: 'owned' }],
    result: dynamic
  }
  const source = createIrBodyBuilder('source-body' as PhysicalBodyId, 'source' as FunctionId, abi)
  const entry = source.openBlock()
  const returns = source.openBlock()
  const throws = source.openBlock()
  const key = source.parameter(entry, lineage('key'), 0, dynamic)
  const binding = 'key-binding' as DeclarationId
  source.bindingWrite(entry, lineage('parameter'), binding, operand(key, dynamic))
  const boxing = conversions.nodeFor(string, dynamic)
  const expected = source.constant(entry, lineage('expected'), 'kModuleError', 'string', string)
  const boxed = source.convert(entry, lineage('box'), boxing.id, operand(expected, string), dynamic)
  if (effect === 'call') {
    const callable: Representation = {
      kind: 'function-value-dispatch',
      abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
    }
    const opaque = source.bindingRead(entry, lineage('opaque-source'), 'opaque-binding' as DeclarationId, callable)
    source.call(entry, lineage('effect'), operand(opaque, callable), null, [], null)
  }
  if (effect === 'arithmetic') {
    const number: Representation = { kind: 'scalar', domain: 'number' }
    const prior = source.constant(entry, lineage('prior'), '1', 'number', number)
    const changed = source.compute(entry, lineage('increment'), 'update', '++', [operand(prior, number)], number)
    source.bindingWrite(entry, lineage('effect-store'), 'observed-counter' as DeclarationId, operand(changed, number))
  }
  const read = source.bindingRead(entry, lineage('read'), binding, dynamic)
  const condition = source.compute(
    entry,
    lineage('comparison'),
    'equality',
    '===',
    [operand(read, dynamic), operand(boxed, dynamic)],
    boolean
  )
  source.branch(entry, lineage('branch'), operand(condition, boolean), returns, throws)
  source.return(returns, lineage('return'), operand(read, dynamic))
  if (cycle) source.jump(throws, lineage('loop'), throws)
  else source.throw(throws, lineage('throw'), operand(read, dynamic))
  const caller = createIrBodyBuilder('caller-body' as PhysicalBodyId, 'caller' as FunctionId, null)
  const callerEntry = caller.openBlock()
  const literal = caller.constant(callerEntry, lineage('argument'), 'compress', 'string', string)
  const arg = caller.convert(callerEntry, lineage('argument-box'), boxing.id, operand(literal, string), dynamic)
  caller.return(callerEntry, null, null)
  const callerBody = caller.seal()
  const definitions = new Map(
    callerBody.blocks.get(callerEntry)!.operations.flatMap((operation): [IrOperand['value'], IrOperation][] => {
      const value = resultOfIrOperation(operation)
      return value === null ? [] : [[value.id, operation]]
    })
  )
  return {
    body: source.seal(),
    args: [operand(arg, dynamic)],
    conversions,
    boxing,
    definitions,
    definitionOf: (id: IrOperand['value']) => definitions.get(id) ?? null
  }
}

test('an actual primitive key survives certified boxing and excludes only the returning branch', () => {
  const found = fixture()
  assert.deepEqual(noNormalCallCompletionOf(found.body, found.args, found.definitionOf, found.conversions), [found.boxing.id])
  assert.equal(found.body.blocks.size, 3)
  assert.equal(
    [...found.body.blocks.values()].some((block) => block.terminator.kind === 'return'),
    true
  )
})

test('a key that enters the returning branch and an unknown argument retain normal completion', () => {
  const found = fixture()
  const constant = [...found.definitions.values()].find((operation) => operation.kind === 'constant')!
  const changed = { ...constant, text: 'kModuleError' }
  const definitions = new Map(found.definitions).set(resultOfIrOperation(constant)!.id, changed)
  assert.equal(
    noNormalCallCompletionOf(found.body, found.args, (id) => definitions.get(id) ?? null, found.conversions),
    null
  )
  assert.equal(
    noNormalCallCompletionOf(found.body, found.args, () => null, found.conversions),
    null
  )
})

test('an opaque effect invalidates mutable parameter cells and a cyclic path is unknown', () => {
  for (const found of [fixture('call'), fixture(false, true)])
    assert.equal(noNormalCallCompletionOf(found.body, found.args, found.definitionOf, found.conversions), null)
})

test('native primitive arithmetic and its observed write remain in the throwing path', () => {
  const found = fixture('arithmetic')
  assert.ok(noNormalCallCompletionOf(found.body, found.args, found.definitionOf, found.conversions))
  assert.equal(
    [...found.body.blocks.values()]
      .flatMap((block) => block.operations)
      .some((operation) => operation.kind === 'binding-write' && operation.declaration === 'observed-counter'),
    true
  )
})

test('async, rest and exception regions do not borrow the synchronous fixed-frame result', () => {
  const found = fixture()
  for (const body of [
    { ...found.body, async: true as const },
    { ...found.body, abi: { ...found.body.abi!, restFrom: 0 } },
    { ...found.body, tryRegions: [{} as never] }
  ])
    assert.equal(noNormalCallCompletionOf(body, found.args, found.definitionOf, found.conversions), null)
})

test('an unstamped primitive conversion and a mismatched supplied carrier cannot become a known key', () => {
  const found = fixture()
  const capability = found.boxing.capability
  assert.ok(capability.kind === 'atom' || capability.kind === 'static')
  const { primitiveIdentityTransport, ...materializer } = capability.materializer
  assert.equal(primitiveIdentityTransport, 'preserved')
  const erased = { ...found.boxing, capability: { ...capability, materializer } }
  const conversions = { nodeById: (id: string) => (id === erased.id ? erased : found.conversions.nodeById(id)) }
  assert.equal(noNormalCallCompletionOf(found.body, found.args, found.definitionOf, conversions), null)
  assert.equal(noNormalCallCompletionOf(found.body, [operand(found.args[0]!.value, string)], found.definitionOf, found.conversions), null)
})
