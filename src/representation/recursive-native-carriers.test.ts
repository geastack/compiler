import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import type { DeclarationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import { cppRecursiveContainerDeclarations, cppRecursiveContainerTraceEdges } from '../targets/cpp/recursive-containers.js'
import { cppRecursiveContainerName, cppTypeOf } from '../targets/cpp/types.js'
import { createRepresentationDeriver } from './derive.js'
import type { SealedRepresentationPlan } from './plan.js'
import { representationKey, walkRepresentation, type Representation } from './model.js'
import { verifyRepresentationPlan } from './verify.js'

const type = (name: string): StructuralTypeId => name as StructuralTypeId
const declaration = (name: string): DeclarationId => name as DeclarationId
const result = (name: string): SemanticResultId => name as SemanticResultId

const recursiveReference = (identity: StructuralTypeId, container: 'array-object' | 'keyed-collection' | 'dictionary'): Representation => ({
  kind: 'native-record-ref',
  shapeId: identity,
  ownership: 'shared-refcount',
  native: `recursive-container:${identity}`,
  recursive: { type: identity, container, role: 'reference' }
})

const planOf = (...representations: readonly Representation[]): SealedRepresentationPlan => ({
  selected: new Map(representations.map((representation, index) => [result(`recursive-${index}`), representation])),
  evidence: new Map(),
  conflicts: []
})

// The two renderers translation-unit.ts calls separately (struct bodies stay
// where they render; the TraceEdges specialisation the caller has to close
// the isolating namespace for) are recombined here so a syntax check still
// exercises both -- these tests compile at true global scope, so the
// specialisation's empty qualifier is the right one everywhere below.
const emittedFor = (plan: SealedRepresentationPlan): string =>
  [...cppRecursiveContainerDeclarations(plan), ...cppRecursiveContainerTraceEdges(plan, '')].join('\n')

const syntaxCheckRecursiveContainers = (declarations: string, completenessChecks: string): void => {
  const compiler = process.env.CXX ?? 'clang++'
  const checked = spawnSync(
    compiler,
    ['-std=c++20', '-fsyntax-only', `-I${resolve(import.meta.dirname, '../../src/targets/cpp/runtime')}`, '-x', 'c++', '-'],
    {
      input: `#include "gea_runtime.h"\n${declarations}\n${completenessChecks}\n`,
      encoding: 'utf8'
    }
  )
  const diagnostics = [checked.stdout, checked.stderr, checked.error?.message].filter(Boolean).join('\n')
  assert.equal(checked.status, 0, `${compiler} rejected generated recursive-container declarations:\n${diagnostics}`)
}

test('derivation closes a recursive alias and its collection body at one wrapper identity', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const alias = table.anchor('recursive-map-alias').id
  const mapBody = table.intern({
    kind: 'declared',
    declaration: declaration('Map'),
    typeArguments: [string, alias],
    body: null
  })
  table.complete(alias, {
    kind: 'declared',
    declaration: declaration('RecursiveMap'),
    typeArguments: [],
    body: mapBody
  })
  const deriver = createRepresentationDeriver(table.seal(), undefined, undefined, undefined, undefined, {
    forDeclaration: (candidate) => (candidate === declaration('Map') ? 'map' : null)
  })

  const carrier = deriver.derive(alias)
  assert.equal(carrier.kind, 'keyed-collection')
  assert.equal(carrier.recursive?.role, 'definition')
  assert.equal(carrier.value?.kind, 'native-record-ref')
  assert.equal(carrier.value?.recursive?.role, 'reference')
  assert.strictEqual(deriver.derive(mapBody), carrier)
})

test('recursive dictionary aliases and their object bodies share the exact carrier in either derivation order', () => {
  const table = createStructuralTypeTable()
  const alias = table.anchor('recursive-dictionary-alias').id
  const dictionaryBody = table.intern({
    kind: 'object',
    members: [],
    index: [{ key: 'string', value: alias, readonly: false }],
    membersDropped: false
  })
  table.complete(alias, {
    kind: 'declared',
    declaration: declaration('RecursiveDictionary'),
    typeArguments: [],
    body: dictionaryBody
  })
  const types = table.seal()

  const aliasFirst = createRepresentationDeriver(types)
  const aliasCarrier = aliasFirst.derive(alias)
  assert.equal(aliasCarrier.kind, 'dictionary')
  assert.equal(aliasCarrier.recursive?.type, alias)
  assert.equal(aliasCarrier.recursive?.role, 'definition')
  assert.equal(aliasCarrier.value.kind, 'native-record-ref')
  assert.equal(aliasCarrier.value.recursive?.type, alias)
  assert.strictEqual(aliasFirst.derive(dictionaryBody), aliasCarrier)

  const bodyFirst = createRepresentationDeriver(types)
  const bodyCarrier = bodyFirst.derive(dictionaryBody)
  assert.equal(bodyCarrier.kind, 'dictionary')
  assert.strictEqual(bodyFirst.derive(alias), bodyCarrier)
})

test('an anonymous map and function-and-constructor root close identically in either derivation order', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const root = table.anchor('recursive-call-construct-root').id
  const map = table.intern({
    kind: 'declared',
    declaration: declaration('Map'),
    typeArguments: [string, root],
    body: null
  })
  const convention = { parameters: [], minimumArity: 0, thisParameter: null, result: map }
  table.complete(root, { kind: 'signature', call: [convention], construct: [convention] })
  const types = table.seal()
  const createDeriver = () =>
    createRepresentationDeriver(types, undefined, undefined, undefined, undefined, {
      forDeclaration: (candidate) => (candidate === declaration('Map') ? 'map' : null)
    })

  const deriver = createDeriver()
  const carrier = deriver.derive(root)
  const mapCarrier = deriver.derive(map)
  assert.equal(carrier.kind, 'function-and-constructor')
  assert.equal(carrier.call.result.kind, 'keyed-collection')
  assert.equal(carrier.construct.result.kind, 'keyed-collection')
  assert.equal(carrier.call.result.recursive?.role, 'definition')
  assert.equal(carrier.construct.result.recursive?.role, 'definition')
  assert.equal(mapCarrier.kind, 'keyed-collection')
  assert.equal(mapCarrier.recursive?.role, 'definition')
  assert.equal(mapCarrier.value?.kind, 'function-and-constructor')
  assert.equal(mapCarrier.value?.call.result.kind, 'native-record-ref')
  assert.ok([...walkRepresentation(carrier)].every((nested) => nested.kind !== 'dynamic' && nested.kind !== 'unresolved'))
  assert.deepEqual(verifyRepresentationPlan(planOf(carrier, mapCarrier)), [])

  const emitted = cppRecursiveContainerDeclarations(planOf(carrier, mapCarrier)).join('\n')
  const wrapper = cppRecursiveContainerName(map)
  assert.ok(emitted.includes(`gea::CallableConstructorObject<gea::Ref<${wrapper}>(), gea::Ref<${wrapper}>()>`))
  syntaxCheckRecursiveContainers(emittedFor(planOf(carrier, mapCarrier)), `static_assert(sizeof(${wrapper}) > 0);`)

  const mapFirst = createDeriver()
  const mapFirstCarrier = mapFirst.derive(map)
  const finalizedRoot = mapFirst.derive(root)
  assert.equal(mapFirstCarrier.kind, 'keyed-collection')
  assert.equal(finalizedRoot.kind, 'function-and-constructor')
  assert.strictEqual(finalizedRoot.call.result, mapFirstCarrier)
  assert.strictEqual(finalizedRoot.construct.result, mapFirstCarrier)
  assert.equal(representationKey(finalizedRoot), representationKey(carrier))

  const rootOnlyPlan = planOf(finalizedRoot)
  assert.deepEqual(verifyRepresentationPlan(rootOnlyPlan), [])
  const rootOnlyDeclarations = cppRecursiveContainerDeclarations(rootOnlyPlan).join('\n')
  assert.ok(rootOnlyDeclarations.includes(`struct ${wrapper} final`))
  syntaxCheckRecursiveContainers(emittedFor(rootOnlyPlan), `static_assert(sizeof(${wrapper}) > 0);`)
})

test('an optional function root closes an anonymous dictionary at a stable native identity', () => {
  const table = createStructuralTypeTable()
  const undefinedValue = table.intern({ kind: 'primitive', primitive: 'undefined' })
  const optionalRoot = table.anchor('recursive-optional-function-root').id
  const functionRoot = table.intern({
    kind: 'signature',
    call: [{ parameters: [], minimumArity: 0, thisParameter: null, result: optionalRoot }],
    construct: []
  })
  const dictionary = table.intern({
    kind: 'object',
    members: [],
    index: [{ key: 'string', value: functionRoot, readonly: false }],
    membersDropped: false
  })
  table.complete(optionalRoot, { kind: 'union', members: [dictionary, undefinedValue] })
  const deriver = createRepresentationDeriver(table.seal())

  const carrier = deriver.derive(optionalRoot)
  const dictionaryCarrier = deriver.derive(dictionary)
  assert.equal(carrier.kind, 'optional')
  assert.equal(carrier.payload.kind, 'dictionary')
  assert.equal(carrier.payload.recursive?.role, 'definition')
  assert.equal(carrier.payload.value.kind, 'function-value-dispatch')
  assert.equal(carrier.payload.value.abi.result.kind, 'optional')
  assert.equal(carrier.payload.value.abi.result.payload.kind, 'native-record-ref')
  assert.equal(dictionaryCarrier.kind, 'dictionary')
  assert.strictEqual(carrier.payload, dictionaryCarrier)
  assert.ok([...walkRepresentation(carrier)].every((nested) => nested.kind !== 'dynamic' && nested.kind !== 'unresolved'))
  assert.deepEqual(verifyRepresentationPlan(planOf(carrier)), [])
  syntaxCheckRecursiveContainers(emittedFor(planOf(carrier)), '')
})

test('a class constructor root replays through an anonymous map without boxing', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const constructor = table.anchor('recursive-class-constructor-root').id
  const map = table.intern({
    kind: 'declared',
    declaration: declaration('Map'),
    typeArguments: [string, constructor],
    body: null
  })
  const construct = table.intern({
    kind: 'signature',
    call: [],
    construct: [{ parameters: [], minimumArity: 0, thisParameter: null, result: map }]
  })
  table.complete(constructor, {
    kind: 'class-constructor',
    declaration: declaration('RecursiveConstructor'),
    typeArguments: [],
    construct
  })
  const deriver = createRepresentationDeriver(table.seal(), undefined, undefined, undefined, undefined, {
    forDeclaration: (candidate) => (candidate === declaration('Map') ? 'map' : null)
  })

  const carrier = deriver.derive(constructor)
  const mapCarrier = deriver.derive(map)
  assert.equal(carrier.kind, 'constructor-family')
  assert.equal(carrier.abi.result.kind, 'keyed-collection')
  assert.equal(carrier.abi.result.recursive?.role, 'definition')
  assert.equal(mapCarrier.kind, 'keyed-collection')
  assert.equal(mapCarrier.recursive?.role, 'definition')
  assert.equal(mapCarrier.value?.kind, 'constructor-family')
  assert.equal(mapCarrier.value?.abi.result.kind, 'native-record-ref')
  assert.ok([...walkRepresentation(carrier)].every((nested) => nested.kind !== 'dynamic' && nested.kind !== 'unresolved'))
  assert.deepEqual(verifyRepresentationPlan(planOf(carrier, mapCarrier)), [])
  syntaxCheckRecursiveContainers(emittedFor(planOf(carrier, mapCarrier)), `static_assert(sizeof(${cppRecursiveContainerName(map)}) > 0);`)
})

test('recursive native Map uses one identity-backed wrapper at its value edge', () => {
  const identity = type('recursive-map')
  const reference = recursiveReference(identity, 'keyed-collection')
  const map: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: { kind: 'string' },
    value: reference,
    ownership: 'shared-refcount',
    recursive: { type: identity, container: 'keyed-collection', role: 'definition' }
  }
  const plan = planOf(map)

  assert.equal(representationKey(map), representationKey(reference))
  assert.deepEqual(
    [...walkRepresentation(map)].map((carrier) => carrier.kind),
    ['keyed-collection', 'string', 'native-record-ref']
  )
  assert.deepEqual(verifyRepresentationPlan(plan), [])
  assert.equal(cppTypeOf(map), `gea::Ref<${cppRecursiveContainerName(identity)}>`)
  assert.ok(
    cppRecursiveContainerDeclarations(plan)
      .join('\n')
      .includes(`gea::Map<std::string, ${cppTypeOf(reference)}>`)
  )
})

test('recursive native Array and dictionary use finite wrappers without a dynamic carrier', () => {
  const listIdentity = type('recursive-list')
  const listReference = recursiveReference(listIdentity, 'array-object')
  const list: Representation = {
    kind: 'array-object',
    element: listReference,
    ownership: 'shared-refcount',
    extension: null,
    recursive: { type: listIdentity, container: 'array-object', role: 'definition' }
  }
  const dictionaryIdentity = type('recursive-dictionary')
  const dictionaryReference = recursiveReference(dictionaryIdentity, 'dictionary')
  const dictionary: Representation = {
    kind: 'dictionary',
    key: 'string',
    value: dictionaryReference,
    ownership: 'shared-refcount',
    recursive: { type: dictionaryIdentity, container: 'dictionary', role: 'definition' }
  }
  const plan = planOf(list, dictionary)

  assert.equal(representationKey(list), representationKey(listReference))
  assert.equal(representationKey(dictionary), representationKey(dictionaryReference))
  assert.ok([...walkRepresentation(list)].every((carrier) => carrier.kind !== 'dynamic'))
  assert.ok([...walkRepresentation(dictionary)].every((carrier) => carrier.kind !== 'dynamic'))
  assert.deepEqual(verifyRepresentationPlan(plan), [])
  assert.equal(cppTypeOf(list), `gea::Ref<${cppRecursiveContainerName(listIdentity)}>`)
  assert.equal(cppTypeOf(dictionary), `gea::Ref<${cppRecursiveContainerName(dictionaryIdentity)}>`)
  assert.equal(cppRecursiveContainerDeclarations(plan).length, 4)
})

test('generated mutually recursive wrappers are ordered and complete C++ against gea_runtime.h', () => {
  const a = type('mutual-a')
  const b = type('mutual-b')
  const aReference = recursiveReference(a, 'keyed-collection')
  const bReference = recursiveReference(b, 'keyed-collection')
  const aDefinition: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: { kind: 'string' },
    value: bReference,
    ownership: 'shared-refcount',
    recursive: { type: a, container: 'keyed-collection', role: 'definition' }
  }
  const bDefinition: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: { kind: 'string' },
    value: aReference,
    ownership: 'shared-refcount',
    recursive: { type: b, container: 'keyed-collection', role: 'definition' }
  }

  const plan = planOf(bDefinition, aDefinition)
  assert.deepEqual(verifyRepresentationPlan(plan), [])
  const emitted = cppRecursiveContainerDeclarations(plan).join('\n')
  const aName = cppRecursiveContainerName(a)
  const bName = cppRecursiveContainerName(b)
  const aForward = emitted.indexOf(`struct ${aName};`)
  const bForward = emitted.indexOf(`struct ${bName};`)
  const aBody = emitted.indexOf(`struct ${aName} final`)
  const bBody = emitted.indexOf(`struct ${bName} final`)

  assert.ok(aForward >= 0)
  assert.ok(bForward >= 0)
  assert.ok(aBody > Math.max(aForward, bForward))
  assert.ok(bBody > Math.max(aForward, bForward))
  assert.ok(emitted.includes(`gea::Map<std::string, gea::Ref<${bName}>>`))
  assert.ok(emitted.includes(`gea::Map<std::string, gea::Ref<${aName}>>`))
  syntaxCheckRecursiveContainers(
    emittedFor(plan),
    [
      `static_assert(sizeof(${aName}) > 0);`,
      `static_assert(sizeof(${bName}) > 0);`,
      `static_assert(std::is_base_of_v<gea::Map<std::string, gea::Ref<${bName}>>, ${aName}>);`,
      `static_assert(std::is_base_of_v<gea::Map<std::string, gea::Ref<${aName}>>, ${bName}>);`
    ].join('\n')
  )
})

test('recursive records retain their existing nominal reference carrier', () => {
  const identity = type('recursive-record')
  const record: Representation = {
    kind: 'record',
    shapeId: identity,
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'value', value: { kind: 'scalar', domain: 'number' }, required: true },
      { key: 'next', value: { kind: 'native-record-ref', shapeId: identity, ownership: 'shared-refcount', native: null }, required: true }
    ]
  }

  assert.deepEqual(
    [...walkRepresentation(record)].map((carrier) => carrier.kind),
    ['record', 'scalar', 'native-record-ref']
  )
  assert.equal(cppRecursiveContainerDeclarations(planOf(record)).length, 0)
})

test('recursive wrapper names preserve distinct structural identities', () => {
  assert.notEqual(cppRecursiveContainerName(type('a-b')), cppRecursiveContainerName(type('a_b')))
})
