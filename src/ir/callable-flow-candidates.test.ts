import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId, PhysicalBodyId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { callableFlowCandidatesOf } from './callable-flow-candidates.js'
import type { IrBody, IrOperation } from './model.js'

const abi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } } as const
const callable: Representation = { kind: 'function-value-dispatch', abi }
const lineage = 'flow-candidate-test' as never
const operand = (value: string) => ({ value: value as never, representation: callable })
const result = (id: string) => ({ id: id as never, representation: callable })
const bodyOf = (owner: string, operations: readonly IrOperation[]): IrBody => {
  const entry = `${owner}-entry` as never
  return {
    owner: owner as PhysicalBodyId,
    sourceOwner: owner as FunctionId,
    abi: null,
    construct: null,
    entry,
    blocks: new Map([[entry, { id: entry, operations: operations as never, terminator: { kind: 'return', lineage: null, value: null } }]]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}
const allocate = (id: string, functionId: string): IrOperation => ({
  kind: 'allocate-callable',
  lineage,
  functionId: functionId as FunctionId,
  captures: [],
  result: result(id)
})
const callTo = (functionId: string, args: readonly string[]): IrOperation => ({
  kind: 'call',
  lineage,
  callee: operand(`${functionId}-callee`),
  receiver: null,
  arguments: args.map(operand),
  result: null,
  target: { kind: 'direct', functionId: functionId as FunctionId }
})
const callThrough = (callee: string): IrOperation => ({
  kind: 'call',
  lineage,
  callee: operand(callee),
  receiver: null,
  arguments: [],
  result: null
})
const captured = 'captured-callback' as DeclarationId

// `apply(fn)` calls `fn` directly and through a closure that captured it.
const program = (callers: readonly (readonly string[])[]) => [
  ...callers.map((functions, index) =>
    bodyOf(`caller${index}`, [
      ...functions.map((functionId, at) => allocate(`fn${index}-${at}`, functionId)),
      ...functions.map((_, at) => callTo('apply', [`fn${index}-${at}`]))
    ])
  ),
  bodyOf('apply', [
    { kind: 'parameter', lineage, ordinal: 0, result: result('parameter') },
    { kind: 'binding-write', lineage, declaration: captured, value: operand('parameter') },
    callThrough('parameter')
  ]),
  bodyOf('closure', [{ kind: 'binding-read', lineage, declaration: captured, result: result('read') }, callThrough('read')])
]

test('a parameter and the capture holding it name the one function every caller passes', () => {
  const candidates = callableFlowCandidatesOf(program([['square'], ['square']]), new Map())
  assert.equal(candidates.get('apply' as PhysicalBodyId)?.get('parameter' as never)?.functionId, 'square')
  assert.equal(candidates.get('closure' as PhysicalBodyId)?.get('read' as never)?.functionId, 'square')
})

test('two different functions through one parameter name neither', () => {
  const candidates = callableFlowCandidatesOf(program([['square'], ['cube']]), new Map())
  assert.equal(candidates.get('apply' as PhysicalBodyId)?.get('parameter' as never), undefined)
  assert.equal(candidates.get('closure' as PhysicalBodyId)?.get('read' as never), undefined)
})
