import assert from 'node:assert/strict'
import test from 'node:test'
import { declarationId, functionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { createRepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { dynamicValueLoadText, programConversionText, unboxedLoadText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { emptyCaptureIndex } from '../targets/cpp/emit-context.js'
import { prototypeReadHooks } from '../targets/cpp/virtual-methods.js'
import { nativeFieldPolicyType } from '../targets/cpp/records.js'
import { cppBodyName, cppTypeOf } from '../targets/cpp/types.js'
import { recordLayoutPolicyOf } from '../projection/fields.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'
import { nativeFieldViewPlansOf } from '../conversion/native-field-view.js'
import { createConversionNodes } from '../conversion/nodes.js'
import type { IrBody } from './model.js'
import {
  dynamicFieldConversionOwnerOf,
  programConversionInputsOf,
  programConversionRecipesMatch,
  publishProgramConversionRecipes
} from './program-conversions.js'

const declaration = declarationId('program-recipes', 0)
const constructor = functionId(declarationId('program-recipes', 1))
const asyncOwner = functionId(declarationId('program-recipes', 2))
const number: Representation = { kind: 'scalar', domain: 'number' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const nothing: Representation = { kind: 'void' }
const receiver: Representation = {
  kind: 'class-ref',
  declaration,
  shapeId: 'program-instance',
  ancestors: [],
  ownership: 'shared-refcount'
}
const abi = (value: Representation): CallableAbi => ({
  receiver,
  parameters: [{ value, passing: 'by-value', ownership: 'owned' }],
  result: nothing,
  restFrom: null
})
const layout: ClassLayout = {
  declaration,
  instance: receiver,
  base: null,
  nativeBase: null,
  constructor,
  construct: abi(number),
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null
}
const deriver = { layoutOf: () => null } as unknown as RepresentationDeriver
const constructorBody = { sourceOwner: constructor, abi: abi(dynamic), blocks: new Map() } as unknown as IrBody
const asyncBody = {
  sourceOwner: asyncOwner,
  abi: { receiver: null, parameters: [], result: nothing, restFrom: null },
  async: true,
  blocks: new Map([['entry', { operations: [{ kind: 'await' }], terminator: { kind: 'return', value: null } }]])
} as unknown as IrBody
const inputs = () => ({
  bodies: [constructorBody, asyncBody],
  classes: new Map([[declaration, layout]]),
  deriver,
  conversions: createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
})

test('full native property artifacts cite exact accessor bodies and omit unused or captured entries', () => {
  const input = inputs()
  const getter = functionId(declarationId('program-recipes', 20))
  const setter = functionId(declarationId('program-recipes', 21))
  const accessor = { key: 'count', getter, setter }
  const body = (sourceOwner: typeof getter, convention: CallableAbi): IrBody =>
    ({ sourceOwner, abi: convention, blocks: new Map() }) as unknown as IrBody
  const own: ClassLayout = { ...layout, constructor: null, construct: null, accessors: [accessor] }
  const program = {
    ...input,
    bodies: [body(getter, { ...abi(number), receiver: null, parameters: [], result: number }), body(setter, abi(number))],
    classes: new Map([[declaration, own]])
  }
  assert.deepEqual(
    programConversionInputsOf(program).map((entry) => entry.role),
    ['prototype-getter-result', 'prototype-setter-argument']
  )
  const reflection = {
    complete: true,
    classes: new Map([[declaration, { level: 'keys-only' as const, reasons: new Set<string>(), representations: new Set<string>() }]]),
    records: new Map(),
    byRepresentation: new Map()
  }
  assert.equal(programConversionInputsOf({ ...program, reflection }).length, 0)
  const captured = {
    ...program,
    bodies: program.bodies.map(
      (entry) =>
        ({
          ...entry,
          facts: {
            capturedDeclarations: [declaration],
            capturedReceiver: null,
            allocatedAsValue: true,
            readsReceiver: false,
            boxed: new Set(),
            requiresEarlyBox: new Set()
          }
        }) as IrBody
    )
  }
  assert.equal(programConversionInputsOf(captured).length, 0)
})

test('a retained layout-only getter publishes its physical result without licensing a constructor or a public-shape ABI', () => {
  const input = inputs()
  const getter = functionId(declarationId('retained-getter', 1))
  const text: Representation = { kind: 'string' }
  const physical: CallableAbi = { receiver, parameters: [], restFrom: null, result: text }
  const own: ClassLayout = {
    ...layout,
    layoutOnly: true,
    accessors: [{ key: 'code', getter, setter: null, representation: number }]
  }
  const getterBody = { sourceOwner: getter, abi: physical, blocks: new Map() } as unknown as IrBody
  const program = { ...input, classes: new Map([[declaration, own]]), bodies: [constructorBody, getterBody] }
  const planned = programConversionInputsOf(program)
  assert.deepEqual(
    planned.map((entry) => entry.role),
    ['prototype-getter-result']
  )
  assert.equal(planned[0]!.source, text, 'the retained getter body owns the result carrier')
  const recipes = publishProgramConversionRecipes(program)
  const closure = recipeClosureOf(
    recipes.map((recipe) => recipe.conversion),
    input.conversions.nodeById
  )
  const site: ConversionSite = {
    programConversionRecipes: recipes,
    conversionIsCertified: (id) => closure.has(id as never),
    conversions: input.conversions,
    printerDrift: [],
    owner: 'retained-getter',
    layouts: recordLayoutPolicyOf(deriver, program.classes, new Map(), (id) => (id === getter ? physical : null)),
    classes: program.classes,
    captures: emptyCaptureIndex,
    functionFacts: new Map()
  }
  const hooks = prototypeReadHooks(
    program.classes,
    (id) => (id === getter ? physical : null),
    () => true,
    () => true,
    new Map(),
    () => false,
    site
  )
  assert.ok(hooks.definitions.length > 0)
  assert.equal(site.printerDrift.length, 0)
  assert.throws(
    () => programConversionText(site, 'prototype-getter-result', String(declaration), 'code', number, dynamic, 'getter()'),
    /names no certified physical conversion/
  )
  assert.equal(programConversionInputsOf({ ...program, bodies: [constructorBody] }).length, 0)
})

test('native prototype setter hooks request the actual argument policy and preserve native receivers without observing a holder', () => {
  const input = inputs()
  const setter = functionId(declarationId('native-setter', 1))
  const argument: Representation = { kind: 'optional', payload: { kind: 'scalar', domain: 'boolean' }, absence: 'null' }
  const physical = abi(argument)
  const own: ClassLayout = {
    ...layout,
    constructor: null,
    construct: null,
    accessors: [
      { key: 'value', getter: null, setter, representation: number },
      { key: 'readonly', getter: null, setter: null }
    ]
  }
  const program = {
    ...input,
    classes: new Map([[declaration, own]]),
    bodies: [{ sourceOwner: setter, abi: physical, blocks: new Map() } as unknown as IrBody]
  }
  const recipes = publishProgramConversionRecipes(program)
  const closure = recipeClosureOf(
    recipes.map((recipe) => recipe.conversion),
    input.conversions.nodeById
  )
  const site: ConversionSite = {
    programConversionRecipes: recipes,
    conversionIsCertified: (id) => closure.has(id as never),
    conversions: input.conversions,
    printerDrift: [],
    owner: 'native-setter',
    layouts: recordLayoutPolicyOf(deriver, program.classes, new Map(), (id) => (id === setter ? physical : null)),
    classes: program.classes,
    captures: emptyCaptureIndex,
    functionFacts: new Map()
  }
  const hooksOf = (entry: CallableAbi | null, free = true) =>
    prototypeReadHooks(
      program.classes,
      (id) => (id === setter ? entry : null),
      () => free,
      () => true,
      new Map(),
      () => false,
      site
    )
  const hooks = hooksOf(physical)
  assert.ok([...hooks.membersByStruct.values()].flat().some((member) => member.includes('gea_setPrototypePropertyFieldNative')))
  const native = hooks.definitions.join('\n').split('::gea_setPrototypePropertyFieldNative').at(-1)!
  assert.ok(native.includes(`std::optional<${cppTypeOf(argument)}> gea_argument`))
  assert.ok(native.includes(`gea_written.read<${nativeFieldPolicyType(argument)}>(gea_argument)`))
  assert.ok(native.includes(cppBodyName(setter)))
  assert.match(native, /gea_receiver\.as</)
  assert.match(native, /readonly.*SetResult::Rejected/)
  assert.doesNotMatch(native, /gea::Value|dynamicValue|\.box\(/)
  for (const refused of [hooksOf(null), hooksOf(physical, false)]) {
    const text = refused.definitions.join('\n').split('::gea_setPrototypePropertyFieldNative').at(-1)!
    assert.match(text, /no authenticated typed body entry/)
    assert.ok(!text.includes(cppBodyName(setter)))
  }
  const functionArgument: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: nothing }
  }
  const callableFrame = abi(functionArgument)
  const callableProgram = { ...program, bodies: [{ sourceOwner: setter, abi: callableFrame, blocks: new Map() } as unknown as IrBody] }
  const callableRecipes = publishProgramConversionRecipes(callableProgram)
  const callableHooksOf = (conversionSite: ConversionSite) =>
    prototypeReadHooks(
      program.classes,
      (id) => (id === setter ? callableFrame : null),
      () => true,
      () => true,
      new Map(),
      () => false,
      conversionSite
    )
  assert.throws(
    () => callableHooksOf({ ...site, programConversionRecipes: callableRecipes }),
    /requires the exact certified recipe/,
    'the earlier optional-argument certificate does not admit a different physical setter frame'
  )
  const callableClosure = recipeClosureOf(
    callableRecipes.map((recipe) => recipe.conversion),
    input.conversions.nodeById
  )
  const unsupported = callableHooksOf({
    ...site,
    programConversionRecipes: callableRecipes,
    conversionIsCertified: (id) => callableClosure.has(id as never)
  })
  const callableHook = unsupported.definitions.join('\n').split('::gea_setPrototypePropertyFieldNative').at(-1)!
  assert.match(callableHook, /no authenticated typed body entry/)
  assert.ok(!callableHook.includes(cppBodyName(setter)), 'a C++ Function carrier cannot borrow an unproved entry ABI')
})

test('native artifact publication cites only the actual coroutine and construction boundaries', () => {
  const input = inputs()
  const planned = programConversionInputsOf(input)
  assert.deepEqual(
    planned.map((boundary) => boundary.role),
    ['async-entry', 'construct-argument']
  )
  assert.deepEqual(
    planned.map((boundary) => boundary.slot),
    ['', '0']
  )
  const recipes = publishProgramConversionRecipes(input)
  assert.equal(programConversionRecipesMatch(planned, recipes, input.conversions), true)
  assert.equal(programConversionRecipesMatch(planned, [], input.conversions), false)
  assert.equal(
    programConversionRecipesMatch(
      planned,
      recipes.map((recipe) => ({ ...recipe, owner: 'another-owner' })),
      input.conversions
    ),
    false
  )
  assert.equal(
    programConversionRecipesMatch(
      planned,
      recipes.map((recipe) => ({ ...recipe, conversion: { ...recipe.conversion } })),
      input.conversions
    ),
    false
  )
})

test('a selected dynamic field artifact retains its checked live payload, exact slot and complete dependency closure', () => {
  const table = createStructuralTypeTable()
  const text = table.intern({ kind: 'primitive', primitive: 'string' })
  const info = table.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'name' }, type: text, optional: false, readonly: false, accessor: null }],
    index: [],
    membersDropped: false
  })
  const options = table.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'info' }, type: info, optional: false, readonly: false, accessor: null }],
    index: [],
    membersDropped: false
  })
  const deriver = createRepresentationDeriver(table.seal())
  const receiver = deriver.derive(options)
  const classes = new Map()
  const layouts = recordLayoutPolicyOf(deriver, classes, new Map(), () => null)
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const demand = { level: 'full' as const, reasons: new Set<string>(), representations: new Set<string>() }
  const reflection = { complete: true, classes: new Map(), records: new Map([[options, demand]]), byRepresentation: new Map() }
  const input = { bodies: [], classes, deriver, conversions, reflection, representations: [receiver] }
  const expected = programConversionInputsOf(input)
  assert.equal(expected.length, 1)
  assert.equal(expected[0]!.role, 'dynamic-field-write')
  assert.equal(expected[0]!.owner, dynamicFieldConversionOwnerOf(receiver))
  assert.equal(expected[0]!.slot, 'info')
  const recipes = publishProgramConversionRecipes(input)
  assert.equal(programConversionRecipesMatch(expected, recipes, conversions), true)
  const recipe = recipes[0]!
  assert.ok('materializer' in recipe.conversion.capability && recipe.conversion.capability.materializer.documentRecordView)
  const closure = recipeClosureOf([recipe.conversion], conversions.nodeById)
  assert.ok(nativeFieldViewPlansOf(closure.values()).length > 0)
  const site: ConversionSite = {
    conversions,
    programConversionRecipes: recipes,
    conversionIsCertified: (id) => closure.has(id),
    layouts,
    classes,
    captures: emptyCaptureIndex,
    functionFacts: new Map(),
    printerDrift: [],
    owner: 'dynamic-field-artifact'
  }
  const rendered = programConversionText(site, recipe.role, recipe.owner, recipe.slot, recipe.source, recipe.target, 'nextValue()')
  assert.match(rendered!, /makeDocumentViewWithOrigin/)
  assert.match(rendered!, /unboxDynamicDictionary/)
  assert.equal(rendered!.match(/nextValue\(\)/g)?.length, 1)
  const publicTarget = deriver.layoutOf(info)
  assert.equal(unboxedLoadText(publicTarget, 'value'), null, 'a context-free structural identity cast is not a generic dynamic loader')
  const publicNode = conversions.nodeFor(dynamic, publicTarget)
  const publicClosure = recipeClosureOf([publicNode], conversions.nodeById)
  const publicSite = { ...site, conversionIsCertified: (id: string) => publicClosure.has(id) }
  assert.match(
    dynamicValueLoadText(layouts, publicTarget, 'value', { site: publicSite, conversion: publicNode })!,
    /makeDocumentViewWithOrigin/
  )
  assert.equal(dynamicValueLoadText(layouts, publicTarget, 'value'), null)
  assert.equal(dynamicValueLoadText(layouts, publicTarget, 'value', { site: publicSite, conversion: { ...publicNode } }), null)
  assert.equal(programConversionInputsOf({ ...input, representations: [] }).length, 0)
  assert.equal(
    programConversionInputsOf({ ...input, reflection: { ...reflection, records: new Map([[options, { ...demand, level: 'keys-only' }]]) } })
      .length,
    0
  )
  assert.equal(
    programConversionInputsOf({
      ...input,
      reflection: {
        ...reflection,
        records: new Map([[options, { ...demand, fieldOperations: new Map([['info', new Set(['native-read' as const])]]) }]])
      }
    }).length,
    0
  )
  assert.equal(programConversionRecipesMatch(expected, [{ ...recipe, slot: 'other' }], conversions), false)
})

test('a generated native prototype initializer cites the selected source method body before receiver erasure', () => {
  const input = inputs()
  const method = functionId(declarationId('program-recipes', 12))
  const physical: CallableAbi = { receiver, parameters: [], restFrom: null, result: nothing }
  const publicMethod: Representation = { kind: 'function-value-dispatch', abi: { ...physical, receiver: null } }
  const own: ClassLayout = {
    ...layout,
    methods: [{ key: 'probe', callable: method }],
    methodOverrides: [{ key: 'probe', value: publicMethod, required: false }]
  }
  const program = {
    ...input,
    classes: new Map([[declaration, own]]),
    bodies: [
      { sourceOwner: method, abi: physical, blocks: new Map() } as unknown as IrBody,
      {
        sourceOwner: 'prototype-getter',
        abi: null,
        blocks: new Map([
          [
            'entry',
            {
              operations: [
                { kind: 'constant', literal: 'string', text: 'prototype', result: { id: 'key' } },
                {
                  kind: 'get',
                  receiver: { representation: { kind: 'constructor-family', members: [declaration], abi: own.construct } },
                  key: { value: 'key' },
                  result: { representation: receiver }
                }
              ],
              terminator: { kind: 'return', value: null }
            }
          ]
        ])
      } as unknown as IrBody
    ]
  }
  const expected = programConversionInputsOf(program)
  assert.equal(expected.length, 1)
  assert.equal(expected[0]!.role, 'prototype-method')
  const recipes = publishProgramConversionRecipes(program)
  assert.equal(recipes[0]!.conversion, input.conversions.nativeMethodFor(expected[0]!.source, expected[0]!.target))
  assert.equal(programConversionRecipesMatch(expected, recipes, input.conversions), true)
  assert.equal(
    programConversionRecipesMatch(
      expected,
      [{ ...recipes[0]!, conversion: input.conversions.nodeFor(expected[0]!.source, expected[0]!.target) }],
      input.conversions
    ),
    false
  )
  assert.equal(programConversionInputsOf({ ...program, bodies: program.bodies.slice(0, 1) }).length, 0)
})

test('artifact rendering requires the named published slot and exact certified node', () => {
  const input = inputs()
  const recipes = publishProgramConversionRecipes(input)
  const recipe = recipes.find((boundary) => boundary.role === 'construct-argument')!
  const site = {
    conversions: input.conversions,
    programConversionRecipes: recipes,
    conversionIsCertified: (id: string) => id === recipe.conversion.id,
    classes: input.classes,
    layouts: { forShape: () => [] },
    printerDrift: [],
    owner: 'program'
  } as unknown as ConversionSite
  assert.ok(programConversionText(site, recipe.role, recipe.owner, recipe.slot, recipe.source, recipe.target, 'actual'))
  assert.throws(
    () => programConversionText(site, recipe.role, recipe.owner, '1', recipe.source, recipe.target, 'actual'),
    /names no certified physical conversion/
  )
  assert.throws(
    () =>
      programConversionText(
        { ...site, conversionIsCertified: () => false },
        recipe.role,
        recipe.owner,
        recipe.slot,
        recipe.source,
        recipe.target,
        'actual'
      ),
    /requires the exact certified recipe/
  )
})

test('field initialization cites the native storage carrier rather than an incidental operation pair', () => {
  const input = inputs()
  const fieldLayout = {
    ...layout,
    constructor: null,
    construct: null,
    fields: [
      {
        declaration: declarationId('program-recipes', 3),
        key: 'count',
        initializer: constructor,
        representation: number,
        syntheticSubclassMemberOverlay: false
      }
    ],
    nativeStorage: { fields: [{ key: 'count', value: dynamic, required: true }] }
  } as unknown as ClassLayout
  const planned = programConversionInputsOf({ ...input, bodies: [], classes: new Map([[declaration, fieldLayout]]) })
  assert.equal(planned.length, 1)
  assert.equal(planned[0]?.role, 'field-initializer')
  assert.equal(planned[0]?.slot, 'count')
  assert.equal(planned[0]?.source, number)
  assert.equal(planned[0]?.target, dynamic)
})

test('settled virtual adapters publish their exact argument and result conversions without body operations', () => {
  const input = inputs()
  const child = declarationId('program-recipes', 4)
  const baseMethod = functionId(declarationId('program-recipes', 5))
  const childMethod = functionId(declarationId('program-recipes', 6))
  const childReceiver: Representation = { ...receiver, declaration: child, shapeId: 'program-child', ancestors: [declaration] }
  const rootAbi: CallableAbi = { ...abi(number), result: dynamic }
  const childAbi: CallableAbi = { ...abi(dynamic), receiver: childReceiver, result: number }
  const rootLayout: ClassLayout = { ...layout, constructor: null, construct: null, methods: [{ key: 'probe', callable: baseMethod }] }
  const childLayout: ClassLayout = {
    ...rootLayout,
    declaration: child,
    base: declaration,
    instance: childReceiver,
    methods: [{ key: 'probe', callable: childMethod }]
  }
  const body = (sourceOwner: typeof baseMethod, convention: CallableAbi): IrBody =>
    ({ sourceOwner, abi: convention, blocks: new Map() }) as unknown as IrBody
  const planned = programConversionInputsOf({
    ...input,
    bodies: [body(baseMethod, rootAbi), body(childMethod, childAbi)],
    classes: new Map([
      [declaration, rootLayout],
      [child, childLayout]
    ])
  })
  assert.deepEqual(
    planned.map((boundary) => boundary.role),
    ['virtual-parameter', 'virtual-result']
  )
  assert.ok(planned.every((boundary) => boundary.source === number && boundary.target === dynamic))
})
