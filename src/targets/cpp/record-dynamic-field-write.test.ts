import assert from 'node:assert/strict'
import test from 'node:test'
import type { SemanticResultId, StructuralTypeId } from '../../identity/ids.js'
import type { ReflectionExposure, ReflectionFieldOperation } from '../../ir/reflection-demand.js'
import { integerStorageSlot } from '../../ir/integer-storage.js'
import { publishProgramConversionRecipes } from '../../ir/program-conversions.js'
import { createConversionNodes } from '../../conversion/nodes.js'
import { recipeClosureOf } from '../../conversion/recipe-closure.js'
import { nativeFieldViewPlansOf } from '../../conversion/native-field-view.js'
import { recordLayoutPolicyOf } from '../../projection/fields.js'
import { createCppConversionRegistry } from './conversions.js'
import { emptyCaptureIndex } from './emit-context.js'
import type { ConversionSite } from './emit-narrowing.js'
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

// A `setOption(options: any, ...)` helper wrote a nested-record field
// through the boxed field dispatcher, whose write arm for every object-carrying
// field was a run-time refusal. It is the checked `any -> record` conversion.
test('a dynamic write into a nested-record field consumes a checked live native artifact recipe', () => {
  const { shape, deriver, carrier } = optionsShape()
  const classes = new Map()
  const layouts = recordLayoutPolicyOf(deriver, classes, new Map(), () => null)
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const reflection = exposureOf(shape, new Map([['info', new Set<ReflectionFieldOperation>(['write', 'define'])]]))
  const programConversionRecipes = publishProgramConversionRecipes({
    bodies: [],
    classes,
    deriver,
    conversions,
    reflection,
    representations: [carrier]
  })
  assert.equal(programConversionRecipes.length, 1)
  const closure = recipeClosureOf(
    programConversionRecipes.map((recipe) => recipe.conversion),
    conversions.nodeById
  )
  const site: ConversionSite = {
    conversions,
    programConversionRecipes,
    conversionIsCertified: (id) => closure.has(id),
    layouts,
    classes,
    captures: emptyCaptureIndex,
    functionFacts: new Map(),
    printerDrift: [],
    owner: 'record-dynamic-field-write'
  }
  const render = (conversionSite: ConversionSite) =>
    cppRecordDeclarations(
      planOf(carrier),
      deriver,
      classes,
      emptyReactivePlan,
      new Map(),
      undefined,
      undefined,
      new Map(),
      false,
      reflection,
      [carrier],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(nativeFieldViewPlansOf(closure.values()).map((plan) => cppRecordStructName(plan.target.shapeId))),
      () => null,
      conversionSite
    )
  const rendered = render(site)
  assert.deepEqual(rendered.refused, [])
  const declarations = [...rendered.declarations, ...[...rendered.fieldDefinitionsByStruct.values()].flat()].join('\n')
  const writeArm = declarations
    .split('\n')
    .find((line) => line.includes('if (gea_name == "info")') && line.includes('gea_extensible) return false; info = '))
  assert.ok(writeArm, 'the info field has a write arm that stores into the native member')
  assert.ok(writeArm.includes('unboxDynamicDictionary'))
  assert.ok(writeArm.includes('makeDocumentViewWithOrigin'))
  assert.ok(!['adoptProduct', 'dynamicRecordField', 'unboxValue<gea::Ref'].some((token) => writeArm.includes(token)))
  assert.ok(closure.size > 1, 'the future checked entry readers and total writers are retained with the selected artifact')
  assert.ok(!declarations.includes(`refuseUnaddressableField("${cppRecordStructName(shape)}", "info")`))
  assert.equal(render({ ...site, programConversionRecipes: [] }).refused.length, 1, 'a demanded write cannot borrow an uncited target')
  assert.throws(
    () => render({ ...site, conversionIsCertified: () => false }),
    (error) => error instanceof Error && error.message.includes('requires the exact certified recipe')
  )
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
      exposureOf(shape, fields),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => null
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
