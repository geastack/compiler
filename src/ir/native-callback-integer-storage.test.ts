import assert from 'node:assert/strict'
import test from 'node:test'
import { integerParameterSlot, integerResultSlot, integerStorageCensusOf, type IntegerStorageQuestion } from './integer-storage.js'
import type { IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { IntegerMagnitude } from './integers.js'

const host = 'decl|host' as DeclarationId
const owner = 'function|callback' as FunctionId
const number = { kind: 'scalar', domain: 'number' } as const
const callable = { kind: 'function', functionId: owner } as const
const operand = (value: string, representation: object): IrOperand => ({ value, representation }) as IrOperand
const result = (id: string, representation: object) => ({ id, representation })
const body = (sourceOwner: string, operations: object[], returned: IrOperand | null = null): IrBody =>
  ({
    sourceOwner,
    blockOrder: ['entry'],
    blocks: new Map([
      [
        'entry',
        {
          operations: operations as IrNonTerminatorOperation[],
          terminator: { kind: 'return', value: returned }
        }
      ]
    ])
  }) as unknown as IrBody

function census(
  options: {
    bounds?: readonly (IntegerMagnitude | null)[]
    unknownEscape?: boolean
    convertedHost?: boolean
    directFloat?: boolean
    mixedHost?: boolean
    forward?: boolean
    recursive?: boolean
    unknownSlot?: boolean
    forwardDepth?: number
    divergentCycle?: boolean
  } = {}
) {
  const hostOperand = operand(options.convertedHost ? 'host-converted' : 'host', { kind: 'function-value-dispatch' })
  const callbackOperand = operand(
    options.recursive ? 'callback-read' : 'callback',
    options.recursive ? { kind: 'function-value-dispatch' } : callable
  )
  const operations: object[] = [
    { kind: 'binding-read', declaration: host, result: result('host', { kind: 'function-value-dispatch' }) },
    { kind: 'allocate-callable', functionId: owner, result: result('callback', callable), captures: [] }
  ]
  if (options.recursive)
    operations.push(
      { kind: 'binding-write', declaration: 'decl|callback', value: operand('callback', callable) },
      { kind: 'binding-read', declaration: 'decl|callback', result: result('callback-read', { kind: 'function-value-dispatch' }) }
    )
  if (options.convertedHost)
    operations.push({
      kind: 'convert',
      source: operand('host', { kind: 'function-value-dispatch' }),
      result: result('host-converted', { kind: 'function-value-dispatch' })
    })
  operations.push({
    kind: 'call',
    callee: hostOperand,
    receiver: null,
    arguments: options.unknownSlot ? [callbackOperand, callbackOperand] : [callbackOperand],
    result: null
  })
  if (options.mixedHost)
    operations.push(
      { kind: 'binding-read', declaration: 'decl|float-host', result: result('float-host', { kind: 'function-value-dispatch' }) },
      {
        kind: 'call',
        callee: operand('float-host', { kind: 'function-value-dispatch' }),
        receiver: null,
        arguments: [callbackOperand],
        result: null
      }
    )
  if (options.unknownEscape)
    operations.push({
      kind: 'call',
      callee: operand('unknown', { kind: 'dynamic' }),
      receiver: null,
      arguments: [callbackOperand],
      result: null
    })
  if (options.directFloat)
    operations.push(
      { kind: 'constant', literal: 'number', text: '0.5', result: result('fraction', number) },
      { kind: 'call', callee: callbackOperand, receiver: null, arguments: [operand('fraction', number)], result: null }
    )
  if (options.divergentCycle)
    operations.push(
      { kind: 'constant', literal: 'number', text: '1', result: result('cycle-seed', number) },
      {
        kind: 'call',
        callee: operand('cycle', { kind: 'function', functionId: 'function|cycle' }),
        receiver: null,
        arguments: [operand('cycle-seed', number)],
        result: null
      }
    )
  return integerStorageCensusOf({
    bodies: [
      body('region|main', operations),
      body(
        owner,
        [
          { kind: 'parameter', ordinal: 0, result: result('timestamp', number) },
          ...(options.recursive
            ? [
                { kind: 'binding-read', declaration: host, result: result('self-host', { kind: 'function-value-dispatch' }) },
                {
                  kind: 'binding-read',
                  declaration: 'decl|callback',
                  result: result('self-callback', { kind: 'function-value-dispatch' })
                },
                {
                  kind: 'call',
                  callee: operand('self-host', { kind: 'function-value-dispatch' }),
                  receiver: null,
                  arguments: [operand('self-callback', { kind: 'function-value-dispatch' })],
                  result: null
                }
              ]
            : []),
          ...(options.forward
            ? [
                {
                  kind: 'call',
                  callee: operand('tick', { kind: 'function', functionId: 'function|tick' }),
                  receiver: null,
                  arguments: [operand('timestamp', number)],
                  result: null
                }
              ]
            : []),
          ...(options.forwardDepth
            ? [
                {
                  kind: 'call',
                  callee: operand('forward', { kind: 'function', functionId: 'function|forward0' }),
                  receiver: null,
                  arguments: [operand('timestamp', number)],
                  result: null
                }
              ]
            : [])
        ],
        operand('timestamp', number)
      ),
      ...(options.forward ? [body('function|tick', [{ kind: 'parameter', ordinal: 0, result: result('tick-time', number) }])] : []),
      ...Array.from({ length: options.forwardDepth ?? 0 }, (_, index) =>
        body(`function|forward${index}`, [
          { kind: 'parameter', ordinal: 0, result: result(`time${index}`, number) },
          ...(index + 1 < (options.forwardDepth ?? 0)
            ? [
                {
                  kind: 'call',
                  callee: operand(`next${index}`, { kind: 'function', functionId: `function|forward${index + 1}` }),
                  receiver: null,
                  arguments: [operand(`time${index}`, number)],
                  result: null
                }
              ]
            : [])
        ])
      ),
      ...(options.divergentCycle
        ? [
            body('function|cycle', [
              { kind: 'parameter', ordinal: 0, result: result('cycle-time', number) },
              { kind: 'constant', literal: 'number', text: '2', result: result('cycle-factor', number) },
              {
                kind: 'compute',
                form: 'binary',
                operator: '*',
                operands: [operand('cycle-time', number), operand('cycle-factor', number)],
                result: result('cycle-next', number)
              },
              {
                kind: 'call',
                callee: operand('cycle', { kind: 'function', functionId: 'function|cycle' }),
                receiver: null,
                arguments: [operand('cycle-next', number)],
                result: null
              },
              ...(options.forwardDepth
                ? [
                    {
                      kind: 'call',
                      callee: operand('cycle-forward', { kind: 'function', functionId: 'function|forward0' }),
                      receiver: null,
                      arguments: [operand('cycle-time', number)],
                      result: null
                    }
                  ]
                : [])
            ])
          ]
        : [])
    ],
    structNameOf: () => null,
    structFamilyOf: () => [],
    fieldStructNameOf: () => null,
    fieldRepresentationOf: () => null,
    excludedStructs: new Set(),
    fieldSeeds: new Map(),
    directCallees: new Map(options.recursive ? [['decl|callback' as DeclarationId, owner]] : []),
    memberCandidates: new Map(),
    methodBodies: new Map(),
    classStructNameOf: () => '',
    excludedFormalOwners: new Set(),
    excludedSignatureSlots: new Set(),
    nativeCallbackParameters: new Map([
      [host, new Map([[0, options.bounds ?? [{ kind: 'bounded', limit: 2 ** 31 }]]])],
      ['decl|float-host' as DeclarationId, new Map([[0, [null]]])]
    ])
  } satisfies IntegerStorageQuestion)
}

test('authenticated native callback integer writes narrow the incoming slot and its reads', () => {
  const answer = census()
  assert.equal(answer.slots.has(integerParameterSlot(owner, 0)), true)
  assert.equal(answer.factsOf(owner).integral.has(integerParameterSlot(owner, 0)), true)
  assert.equal(answer.slots.has(integerResultSlot(owner)), false, 'incoming contract does not authenticate the host result consumer')
})

test('carrier preserving conversions retain authenticated host declaration identity', () => {
  assert.equal(census({ convertedHost: true }).slots.has(integerParameterSlot(owner, 0)), true)
})

test('unknown callback escape defeats an otherwise authenticated native write', () => {
  assert.equal(census({ unknownEscape: true }).slots.has(integerParameterSlot(owner, 0)), false)
})

test('nonintegral host parameters and fractional direct calls remain unproved', () => {
  assert.equal(census({ bounds: [null] }).slots.has(integerParameterSlot(owner, 0)), false)
  assert.equal(census({ directFloat: true }).slots.has(integerParameterSlot(owner, 0)), false)
})

test('out of range native bounds fail closed', () => {
  for (const limit of [Infinity, -1, 2 ** 54]) {
    assert.equal(census({ bounds: [{ kind: 'bounded', limit }] }).slots.has(integerParameterSlot(owner, 0)), false)
  }
})

test('one nonintegral native host write defeats another integral host write', () => {
  assert.equal(census({ mixedHost: true }).slots.has(integerParameterSlot(owner, 0)), false)
})

test('native callback bounds propagate into directly called domain methods', () => {
  assert.equal(census({ forward: true }).slots.has(integerParameterSlot('function|tick' as FunctionId, 0)), true)
})

test('self-rescheduling callbacks retain the bounded native parameter contract', () => {
  assert.equal(census({ recursive: true }).slots.has(integerParameterSlot(owner, 0)), true)
})

test('an uncontracted callback argument remains an unknown escape even with the same SSA value', () => {
  assert.equal(census({ unknownSlot: true }).slots.has(integerParameterSlot(owner, 0)), false)
})

test('native callback bounds propagate through more than eight independent calls', () => {
  const answer = census({ forwardDepth: 12 })
  assert.equal(answer.slots.has(integerParameterSlot(owner, 0)), true)
  assert.equal(answer.slots.has(integerParameterSlot('function|forward11' as FunctionId, 0)), true)
})

test('an unrelated growing magnitude cycle does not discard an authenticated native bound', () => {
  const answer = census({ divergentCycle: true, forward: true })
  assert.equal(answer.slots.has(integerParameterSlot(owner, 0)), true)
  assert.equal(answer.slots.has(integerParameterSlot('function|tick' as FunctionId, 0)), true)
  assert.equal(answer.slots.has(integerParameterSlot('function|cycle' as FunctionId, 0)), false)
})

test('fractional input disqualifies every dependent formal beyond eight calls', () => {
  const answer = census({ directFloat: true, forwardDepth: 12 })
  assert.equal(answer.slots.has(integerParameterSlot(owner, 0)), false)
  for (let index = 0; index < 12; index++)
    assert.equal(answer.slots.has(integerParameterSlot(`function|forward${index}` as FunctionId, 0)), false)
})

test('refusing a growing cycle invalidates provisional bounds throughout its downstream chain', () => {
  const answer = census({ divergentCycle: true, forwardDepth: 12 })
  assert.equal(answer.slots.has(integerParameterSlot(owner, 0)), true)
  for (let index = 0; index < 12; index++)
    assert.equal(answer.slots.has(integerParameterSlot(`function|forward${index}` as FunctionId, 0)), false)
})
