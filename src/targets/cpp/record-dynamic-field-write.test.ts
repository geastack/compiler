import assert from 'node:assert/strict'
import test from 'node:test'
import type { SemanticResultId, StructuralTypeId } from '../../identity/ids.js'
import type { ReflectionExposure, ReflectionFieldOperation } from '../../ir/reflection-demand.js'
import { integerStorageSlot } from '../../ir/integer-storage.js'
import { createRepresentationDeriver } from '../../representation/derive.js'
import type { Representation } from '../../representation/model.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import { createStructuralTypeTable } from '../../semantics/model/structural-type-table.js'
import { cppRecordDeclarations } from './records.js'
import { cppRecordStructName } from './types.js'

const emptyReactivePlan = {
  fields: new Map(),
  cell: null,
  cellPreamble: [],
  dependencies: new Map(),
  nodeDependencies: new Map(),
  projections: new Map(),
  revisions: new Map(),
  celled: new Map(),
  boundRecordFields: new Map(),
      revisionBoundRecordFields: new Map()
}

const planOf = (representation: Representation): SealedRepresentationPlan => ({
  selected: new Map([['options-record' as SemanticResultId, representation]]),
  evidence: new Map(),
  conflicts: []
})

const exposureOf = (shape: StructuralTypeId, fields?: ReadonlyMap<string, ReadonlySet<ReflectionFieldOperation>>): ReflectionExposure => ({
  classes: new Map(),
  records: new Map([
    [shape, { level: 'full', ...(fields ? { fieldOperations: fields } : {}), reasons: new Set(), representations: new Set() }]
  ]),
  byRepresentation: new Map(),
  complete: true
})

/** `{ info: { name?: string }, count: number }` -- a nested record field and a number field. */
const optionsShape = () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const info = table.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'name' }, type: string, optional: true, readonly: false, accessor: null }],
    index: [],
    membersDropped: false
  })
  const shape = table.intern({
    kind: 'object',
    members: [
      { key: { kind: 'string', value: 'info' }, type: info, optional: false, readonly: false, accessor: null },
      { key: { kind: 'string', value: 'count' }, type: number, optional: false, readonly: false, accessor: null }
    ],
    index: [],
    membersDropped: false
  })
  const deriver = createRepresentationDeriver(table.seal())
  return { shape, deriver, carrier: deriver.derive(shape) }
}

// mongodb's `setOption(mongoOptions: any, ...)` wrote `driverInfo: DriverInfo`
// through the boxed field dispatcher, whose write arm for every object-carrying
// field was a run-time refusal. It is the checked `any -> record` conversion.
test('a boxed write into a nested-record field converts through the checked record product', () => {
  const { shape, deriver, carrier } = optionsShape()
  const rendered = cppRecordDeclarations(planOf(carrier), deriver, new Map(), emptyReactivePlan, new Map())
  assert.deepEqual(rendered.refused, [])
  const declarations = rendered.declarations.join('\n')
  const writeArm = declarations
    .split('\n')
    .find((line) => line.includes('if (gea_name == "info")') && line.includes('gea_extensible) return false; info = '))
  assert.ok(writeArm, 'the info field has a write arm that stores into the native member')
  assert.ok(writeArm.includes('gea_dynamic_record'), 'a box that is not already the struct is rebuilt as a checked record product')
  assert.ok(!declarations.includes(`refuseUnaddressableField("${cppRecordStructName(shape)}", "info")`))
})

// A sealed demand names a field operation because the program performs it; if
// the only arm is a refusal, that abort is reached, so it is refused at compile
// time. A number held in a narrowed `long long` has no canonical box payload.
test('a sealed demand on a field with no dynamic recipe refuses the struct by name', () => {
  const { shape, deriver, carrier } = optionsShape()
  const narrowed = new Set([integerStorageSlot(cppRecordStructName(shape), 'count')])
  const render = (fields?: ReadonlyMap<string, ReadonlySet<ReflectionFieldOperation>>) =>
    cppRecordDeclarations(
      planOf(carrier),
      deriver,
      new Map(),
      emptyReactivePlan,
      new Map(),
      new Map(),
      narrowed,
      new Map(),
      false,
      exposureOf(shape, fields)
    )

  const sealed = render(new Map([['count', new Set<ReflectionFieldOperation>(['write'])]]))
  assert.equal(sealed.refused.length, 1)
  assert.equal(sealed.refused[0]!.structName, cppRecordStructName(shape))
  assert.ok(sealed.refused[0]!.reason.includes('count (write)'))

  // An unrestricted demand does not know which key reaches the dispatcher, so
  // the arm stays the run-time refusal rather than refusing every program that
  // boxes the struct and never touches that field.
  assert.deepEqual(render().refused, [])
})
