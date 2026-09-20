import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, IrValueId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { deferrableValuesOf } from './deferral.js'
import type { ForwardingPolicy } from './deferral.js'
import type { ConvertOperation, IrBody, IrNonTerminatorOperation, IrTerminatorOperation } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const union: Representation = {
  kind: 'tagged-union',
  arms: [
    { tag: 'number', value: number, semanticType: 'number' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } },
    { tag: 'string', value: { kind: 'string' }, semanticType: 'string' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } }
  ]
}

const conversion = (source: Representation, result: Representation): ConvertOperation => ({
  kind: 'convert',
  lineage: 'conversion-lineage' as SemanticResultId,
  conversionUse: 'test-conversion',
  source: { value: 'input' as IrValueId, representation: source },
  result: { id: 'converted' as IrValueId, representation: result }
})

const facts = (operation: IrNonTerminatorOperation) => {
  assert.equal(operation.kind, 'convert')
  if (operation.kind !== 'convert') throw new Error('expected conversion')
  const block = 'entry' as IrBody['entry']
  const body: IrBody = {
    owner: 'owner' as IrBody['owner'],
    sourceOwner: 'source' as IrBody['sourceOwner'],
    abi: null,
    construct: null,
    entry: block,
    blocks: new Map([
      [
        block,
        {
          id: block,
          operations: [operation],
          terminator: {
            kind: 'return',
            lineage: null,
            value: { value: operation.result.id, representation: operation.result.representation }
          }
        }
      ]
    ]),
    blockOrder: [block],
    values: new Map(),
    tryRegions: []
  }
  return deferrableValuesOf(body)
}

test('union projection results stay named even with one IR consumer', () => {
  for (const source of [union, { kind: 'optional', payload: union, absence: 'undefined' } as const])
    assert.equal(facts(conversion(source, number)).values.size, 0)
  assert.equal(facts(conversion(number, union)).values.size, 0)
})

test('ordinary optional payload loads can still defer without introducing a sum expansion', () => {
  const source: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  assert.equal(facts(conversion(source, number)).values.size, 1)
})

// --- forwarding: a call result into the operation that immediately consumes
// it, and a const cell out of existence between its one write and one read.

const lineage = 'lineage' as SemanticResultId
const arrayOfNumbers: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
const callable: Representation = {
  kind: 'function-value-dispatch',
  abi: { parameters: [], result: number, receiver: null, restFrom: null }
}
const id = (name: string): IrValueId => name as IrValueId
const operand = (name: string, representation: Representation) => ({ value: id(name), representation })
const result = (name: string, representation: Representation) => ({ id: id(name), representation })
const read = (declaration: string, name: string, representation: Representation): IrNonTerminatorOperation => ({
  kind: 'binding-read',
  lineage,
  declaration: declaration as DeclarationId,
  result: result(name, representation)
})
const write = (declaration: string, value: string, representation: Representation): IrNonTerminatorOperation => ({
  kind: 'binding-write',
  lineage,
  declaration: declaration as DeclarationId,
  value: operand(value, representation)
})
const constant = (name: string): IrNonTerminatorOperation => ({
  kind: 'constant',
  lineage,
  text: '0',
  literal: 'number',
  result: result(name, number)
})
const call = (callee: string, name: string, args: readonly string[] = []): IrNonTerminatorOperation => ({
  kind: 'call',
  lineage,
  callee: operand(callee, callable),
  receiver: null,
  arguments: args.map((argument) => operand(argument, number)),
  result: result(name, number)
})
const bodyOf = (operations: readonly IrNonTerminatorOperation[], terminator?: IrTerminatorOperation): IrBody => {
  const block = 'entry' as IrBody['entry']
  return {
    owner: 'owner' as IrBody['owner'],
    sourceOwner: 'source' as IrBody['sourceOwner'],
    abi: null,
    construct: null,
    entry: block,
    blocks: new Map([[block, { id: block, operations, terminator: terminator ?? { kind: 'return', lineage: null, value: null } }]]),
    blockOrder: [block],
    values: new Map(),
    tryRegions: []
  }
}
const forwardEverything: ForwardingPolicy = { forwardsCallInto: () => true, forwardsBinding: () => true }

test('a call result forwards into the Array element store that immediately follows it', () => {
  const store: IrNonTerminatorOperation = {
    kind: 'set',
    lineage,
    strict: true,
    receiver: operand('arr', arrayOfNumbers),
    key: operand('k', number),
    value: operand('made', number),
    result: null
  }
  const adjacent = bodyOf([read('cells', 'arr', arrayOfNumbers), constant('k'), read('fn', 'f', callable), call('f', 'made'), store])
  assert.equal(deferrableValuesOf(adjacent, () => false, forwardEverything).values.has(id('made')), true)
  assert.equal(deferrableValuesOf(adjacent).values.has(id('made')), false, 'the target must vouch for the store spelling its value once')
  // The call is a barrier for every OTHER value: the key read before it keeps
  // its temporary, exactly as it did before the call could forward.
  assert.equal(deferrableValuesOf(adjacent, () => false, forwardEverything).values.has(id('k')), false)
  const separated = bodyOf([read('cells', 'arr', arrayOfNumbers), read('fn', 'f', callable), call('f', 'made'), constant('k'), store])
  assert.equal(deferrableValuesOf(separated, () => false, forwardEverything).values.has(id('made')), false)
  const converted: IrNonTerminatorOperation = {
    ...store,
    receiver: operand('arr', { kind: 'array-object', element: { kind: 'string' }, ownership: 'shared-refcount', extension: null })
  }
  const aligned = bodyOf([read('cells', 'arr', arrayOfNumbers), constant('k'), read('fn', 'f', callable), call('f', 'made'), converted])
  assert.equal(
    deferrableValuesOf(aligned, () => false, forwardEverything).values.has(id('made')),
    false,
    'an aligned element store is a conversion'
  )
})

test('a call result forwards into an adjacent return, but not across merge writes', () => {
  const returning = bodyOf([read('fn', 'f', callable), call('f', 'made')], {
    kind: 'return',
    lineage: null,
    value: operand('made', number)
  })
  assert.equal(deferrableValuesOf(returning, () => false, forwardEverything).values.has(id('made')), true)
  const entry = 'entry' as IrBody['entry']
  const merge = 'merge' as IrBody['entry']
  const merged: IrBody = {
    ...returning,
    blocks: new Map([
      [
        entry,
        {
          id: entry,
          operations: [read('fn', 'f', callable), call('f', 'made')],
          terminator: { kind: 'return', lineage: null, value: operand('made', number) }
        }
      ],
      [
        merge,
        {
          id: merge,
          operations: [
            { kind: 'phi', lineage, incoming: [{ block: entry, value: operand('f', callable) }], result: result('joined', callable) }
          ],
          terminator: { kind: 'return', lineage: null, value: null }
        }
      ]
    ]),
    blockOrder: [entry, merge]
  }
  assert.equal(deferrableValuesOf(merged, () => false, forwardEverything).values.has(id('made')), false)
})

test('a const cell written once and read once across an effect-free window forwards to its callee position', () => {
  const table = (between: IrNonTerminatorOperation): IrBody =>
    bodyOf([
      read('cells', 'arr', arrayOfNumbers),
      constant('k'),
      { kind: 'get', lineage, receiver: operand('arr', arrayOfNumbers), key: operand('k', number), result: result('slot', callable) },
      write('f', 'slot', callable),
      between,
      read('f', 'callee', callable),
      call('callee', 'made'),
      write('total', 'made', number)
    ])
  const pureBetween = deferrableValuesOf(table(read('total', 'old', number)), () => false, forwardEverything)
  assert.deepEqual(pureBetween.forwardedBindings.get('f' as DeclarationId), { value: operand('slot', callable), read: id('callee') })
  assert.equal(deferrableValuesOf(table(read('total', 'old', number))).forwardedBindings.size, 0, 'the target must vouch for the cell')
  const callBetween = deferrableValuesOf(table(call('callee2', 'other')), () => false, forwardEverything)
  assert.equal(callBetween.forwardedBindings.size, 0, 'a call between the write and the read may change what the element read names')
})

test('a forwarded cell is never handed to a call by reference', () => {
  const asArgument = bodyOf([
    read('cells', 'arr', arrayOfNumbers),
    constant('k'),
    { kind: 'get', lineage, receiver: operand('arr', arrayOfNumbers), key: operand('k', number), result: result('slot', number) },
    write('x', 'slot', number),
    read('x', 'value', number),
    read('fn', 'f', callable),
    call('f', 'made', ['value'])
  ])
  assert.equal(deferrableValuesOf(asArgument, () => false, forwardEverything).forwardedBindings.size, 0)
})
