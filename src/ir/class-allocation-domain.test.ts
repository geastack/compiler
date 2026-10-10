import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classMethodValueArmsOf } from '../projection/dispatch.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { classAllocationDomainOf } from './class-allocation-domain.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import type { IrBody, IrNonTerminatorOperation } from './model.js'

const base = 'allocation-base' as DeclarationId
const child = 'allocation-child' as DeclarationId
const lineage = 'allocation-domain' as never
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const instance = (declaration: DeclarationId): Representation => ({
  kind: 'class-ref',
  declaration,
  shapeId: declaration,
  ownership: 'shared-refcount',
  ancestors: declaration === child ? [base] : []
})
const abi = (declaration: DeclarationId): CallableAbi => ({ receiver: null, parameters: [], restFrom: null, result: instance(declaration) })
const constructor = (declaration: DeclarationId): Representation => ({
  kind: 'constructor-family',
  members: [declaration],
  abi: abi(declaration)
})
const layout = (declaration: DeclarationId): ClassLayout => ({
  declaration,
  base: declaration === child ? base : null,
  nativeBase: null,
  construct: abi(declaration),
  instance: instance(declaration),
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [{ key: 'read', callable: declaration === child ? ('child-read' as never) : null }],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null
})
const classes = new Map([
  [base, layout(base)],
  [child, layout(child)]
])
const operand = (value: string, representation: Representation) => ({ value: value as never, representation })
const result = (id: string, representation: Representation) => ({ id: id as never, representation })
const body = (operations: readonly IrNonTerminatorOperation[]): IrBody => {
  const entry = 'allocation-entry' as IrBody['entry']
  return {
    owner: 'allocation-main' as never,
    sourceOwner: 'allocation-main' as never,
    abi: null,
    construct: null,
    entry,
    blocks: new Map([[entry, { id: entry, operations, terminator: { kind: 'return', lineage: null, value: null } }]]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}
const construct: Extract<IrNonTerminatorOperation, { kind: 'construct' }> = {
  kind: 'construct',
  lineage,
  callee: operand('child-constructor', constructor(child)),
  newTarget: operand('child-constructor', constructor(child)),
  target: { kind: 'exact', target: { kind: 'implicit-source-constructor', classDeclaration: child }, evidence: [] },
  arguments: [],
  result: result('child-instance', instance(child))
}
const deriver = { layoutOf: () => null } as unknown as RepresentationDeriver
const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const flowOf = (bodies: readonly IrBody[], classes: ReadonlyMap<DeclarationId, ClassLayout>) =>
  nativeCallableFlowOf(bodies, new Map(), classes, conversions, undefined, deriver)
const domain = (operations: readonly IrNonTerminatorOperation[]) =>
  classAllocationDomainOf([body(operations)], classes, new Map(), deriver, flowOf([body(operations)], classes))

test('class evaluation and super initialization do not allocate a separate base instance', () => {
  const allocations = domain([
    { kind: 'allocate-constructor', lineage, declaration: base, captures: [], result: result('base-constructor', constructor(base)) },
    construct,
    { kind: 'super-initialize', lineage, arguments: [] }
  ])
  assert.deepEqual([...allocations], [child])
  const projected = new Map(
    [...classes].map(([id, value]) => [id, { ...value, ...(!allocations.has(id) ? { allocationAbsent: true as const } : {}) }])
  )
  assert.deepEqual(
    classMethodValueArmsOf(projected, base, 'read')?.map((arm) => arm.allocation),
    [child]
  )
  assert.equal(classMethodValueArmsOf(classes, base, 'read'), null, 'an absent body alone does not narrow allocations')
})

test('implicit constructions keep exact generic copies live without allocating their source template', () => {
  const template = 'generic-cell' as DeclarationId
  const textCopy = 'generic-cell@0' as DeclarationId
  const booleanCopy = 'generic-cell@1' as DeclarationId
  const family = new Map([template, textCopy, booleanCopy].map((id) => [id, { ...layout(id), base: null }]))
  const constructions = [textCopy, booleanCopy].map((id) => ({
    ...construct,
    callee: operand(`constructor-${id}`, constructor(id)),
    newTarget: operand(`constructor-${id}`, constructor(id)),
    target: { kind: 'exact' as const, target: { kind: 'implicit-source-constructor' as const, classDeclaration: id }, evidence: [] },
    result: result(`instance-${id}`, instance(id))
  }))
  const allocations = classAllocationDomainOf([body(constructions)], family, new Map(), deriver, flowOf([body(constructions)], family))
  assert.deepEqual([...allocations], [textCopy, booleanCopy])
  assert.equal(allocations.has(template), false)
})

test('a source constructor copy resolves through its published shared physical layout', () => {
  const physical = 'generic-empty@0' as DeclarationId
  const sourceCopy = 'generic-empty@1' as DeclarationId
  const family = new Map([[physical, { ...layout(physical), base: null, copies: [physical, sourceCopy] }]])
  const operation = {
    ...construct,
    callee: operand('generic-constructor', constructor(physical)),
    newTarget: operand('generic-constructor', constructor(physical)),
    target: {
      kind: 'exact' as const,
      target: { kind: 'implicit-source-constructor' as const, classDeclaration: sourceCopy },
      evidence: []
    },
    result: result('generic-instance', instance(physical))
  }
  assert.deepEqual(
    nativeClassConstructionOf(operation, family, () => null, conversions)?.map((branch) => branch.declaration),
    [physical]
  )
  assert.deepEqual(
    [...classAllocationDomainOf([body([operation])], family, new Map(), deriver, flowOf([body([operation])], family))],
    [physical]
  )
})

test('dynamic constructor exposure and open construction preserve otherwise absent allocations', () => {
  const exposed = domain([
    construct,
    {
      kind: 'convert',
      lineage,
      conversionUse: 'constructor-exposure',
      source: operand('base-constructor', constructor(base)),
      result: result('exposed-constructor', dynamic)
    }
  ])
  assert.ok(exposed.has(base) && exposed.has(child))
  const open = domain([
    {
      ...construct,
      callee: operand('unknown-constructor', dynamic),
      newTarget: operand('unknown-constructor', dynamic),
      target: { kind: 'open', evidence: [] }
    }
  ])
  assert.ok(open.has(base) && open.has(child))
})

test('an unknown callable receiving a native child may recover and construct its base constructor', () => {
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
  }
  const adapter = conversions.nodeFor(dynamic, callable)
  assert.notEqual(adapter.capability.kind, 'never')
  const allocations = domain([
    construct,
    { kind: 'convert', lineage, conversionUse: adapter.id, source: operand('unknown-method', dynamic), result: result('method', callable) },
    {
      kind: 'call',
      lineage,
      callee: operand('method', callable),
      receiver: null,
      thisArgument: operand('child-instance', instance(child)),
      arguments: [],
      result: null
    }
  ])
  assert.ok(allocations.has(base) && allocations.has(child))
})
