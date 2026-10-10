import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { createConversionNodes } from '../../conversion/nodes.js'
import { createRepresentationDeriver } from '../../representation/derive.js'
import { representationKey } from '../../representation/model.js'
import { createCppConversionRegistry } from '../../targets/cpp/conversions.js'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createIdentityTable } from './identities.js'
import { createStructuralMapper } from './structural.js'

const normalized = (source: string) => {
  const entry = resolve('test/runtime/asserted-arrow-drops-optional-parameter-and-narrows-result.runtime.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const types = createStructuralTypeTable()
  const mapper = createStructuralMapper(checker, createIdentityTable(program, checker), types)
  const aliases = new Map(
    file.statements.filter(ts.isTypeAliasDeclaration).map((node) => [node.name.text, mapper.typeOf(checker.getTypeFromTypeNode(node.type))])
  )
  const deriver = createRepresentationDeriver(types.seal())
  return { types, aliases, carrier: (name: string) => deriver.derive(aliases.get(name)!) }
}

test('a union preserves each homogeneous mutable dictionary allocation instead of widening every entry', () => {
  const { carrier } = normalized(`
    type Strings = { [key: string]: string };
    type Numbers = { [key: string]: number };
    type Choice = Strings | Numbers;
    type MixedEntries = { [key: string]: string | number };
  `)
  const choice = carrier('Choice')
  assert.equal(choice.kind, 'tagged-union')
  if (choice.kind !== 'tagged-union') return
  assert.deepEqual(
    choice.arms.map((arm) => representationKey(arm.value)).sort(),
    [carrier('Strings'), carrier('Numbers')].map(representationKey).sort()
  )
  const mixed = carrier('MixedEntries')
  assert.equal(mixed.kind, 'dictionary')
  assert.notEqual(representationKey(choice), representationKey(mixed))
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.notEqual(census.nodeFor(carrier('Strings'), choice).capability.kind, 'never', 'the sum holds the same narrow table')
  assert.equal(
    census.nodeFor(carrier('Strings'), mixed).capability.kind,
    'never',
    'the wider mutable table has legal writes absent from string storage'
  )
})

test('mixed optional function-result unions retain exact native table arms for a checked subset adapter', () => {
  const { carrier } = normalized(`
    type Strings = { [key: string]: string };
    type Numbers = { [key: string]: number };
    type Whole = string | Strings | Numbers | undefined;
    type Selected = string | Strings | undefined;
  `)
  const whole = carrier('Whole')
  const selected = carrier('Selected')
  assert.equal(whole.kind, 'optional')
  if (whole.kind !== 'optional') return
  assert.equal(whole.payload.kind, 'tagged-union')
  if (whole.payload.kind !== 'tagged-union') return
  assert.equal(whole.payload.arms.filter((arm) => arm.value.kind === 'dictionary').length, 2)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const narrowing = census.nodeFor(whole, selected)
  assert.notEqual(narrowing.capability.kind, 'never')
  assert.ok(
    (narrowing.capability.kind === 'atom' || narrowing.capability.kind === 'static') && narrowing.capability.materializer.nativeSelection
  )
})
