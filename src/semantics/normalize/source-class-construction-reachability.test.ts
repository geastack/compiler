import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { compile } from '../../compiler.js'
import { censusReachability } from './reachability.js'
const entry = resolve('test/fixtures/construction-live-entry.ts')
const dependency = resolve('test/fixtures/construction-live-dependency.ts')
const declaration = `
export function definitionEffect(){console.log('definition');return 1}
export function constructionEffect(){console.log('construction');return 2}
const key=Symbol('computed')
export class Base { base=constructionEffect(); constructor(){constructionEffect()} }
export class Dormant extends Base {
 static value=definitionEffect();
 [key](){return 1}
 value=constructionEffect();
 constructor(){super();constructionEffect()}
}
`
const input = (source: string, text = declaration) => ({
  rootFileNames: [entry],
  projectFileName: null,
  options: { ...defaultCompilerOptions, types: [] },
  sourceOverlay: new Map([
    [entry, source],
    [dependency, text]
  ])
})
const inspect = (source: string, text = declaration) => {
  const result = createProgram(input(source, text))
  const file = result.program.getSourceFile(dependency)!
  assert.ok(file)
  const reachable = censusReachability({
    checker: result.checker,
    files: result.sourceFiles,
    entries: result.entryFiles,
    runtimeExportOf: (file, name) => result.runtimeExportOf(file.fileName, name)
  })
  const classes = file.statements.filter(ts.isClassDeclaration)
  return { file, reachable, classes }
}
test('module/class definition effects do not execute dormant constructor or instance initializers', () => {
  const { file, reachable, classes } = inspect("import './construction-live-dependency';console.log('entry')")
  assert.ok(
    reachable.statementsOf(file).some((statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'Dormant'),
    'computed/static definition must remain'
  )
  const dormant = classes.find((item) => item.name?.text === 'Dormant')!
  assert.ok(dormant)
  const ctor = dormant.members.find(ts.isConstructorDeclaration)!
  assert.equal(reachable.memberIsPruned(ctor), true, 'class definition is not construction')
  const field = dormant.members.find(
    (item): item is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(item) &&
      item.name.getText() === 'value' &&
      !item.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
  )!
  assert.ok(field.initializer)
  assert.equal(reachable.memberIsPruned(field.initializer), true)
  const stat = dormant.members.find(
    (item): item is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(item) &&
      item.name.getText() === 'value' &&
      !!item.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
  )!
  assert.equal(reachable.memberIsPruned(stat.initializer!), false, 'actual static effect remains')
  assert.ok(
    reachable.statementsOf(file).some((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'definitionEffect')
  )
})
for (const [name, source] of [
  ['direct new', "import {Dormant} from './construction-live-dependency';console.log(new Dormant().value)"],
  ['exported constructor', "export {Dormant} from './construction-live-dependency'"],
  [
    'unknown higherorder escape',
    "import {Dormant} from './construction-live-dependency';declare function accept(value:typeof Dormant):void;accept(Dormant)"
  ],
  [
    'typed constructor parameter',
    "import type {Dormant} from './construction-live-dependency';export function construct(C:typeof Dormant){return new C()}"
  ]
] as const)
  test(`${name} conservatively retains real constructor and base initialization`, () => {
    const { reachable, classes } = inspect(source)
    for (const item of classes) {
      const ctor = item.members.find(ts.isConstructorDeclaration)!
      assert.equal(reachable.memberIsPruned(ctor), false, item.name?.text)
    }
  })
test('normal compiler must not acquire an unused constructor intrinsic mutation obligation', () => {
  const source = `declare const opaque:object;declare const unknownKey:string;const key=Symbol('computed');
export class Dormant{static ready=1;[key](){return 1}constructor(){Object.defineProperty(opaque,unknownKey,{value:1})}}`
  const result = compile(input("import './construction-live-dependency';console.log('entry')", source))
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals.filter((item) => item.stage !== 'census')))
})

for (const [name, source] of [
  ['static self construction', `export class Dormant { static ready=new this(); value=1; constructor(){console.log('constructed')} }`],
  ['static block construction', `export class Dormant { static { new Dormant() } value=1; constructor(){console.log('constructed')} }`]
] as const)
  test(`${name} retains constructor effects from class definition evaluation`, () => {
    const { reachable, classes } = inspect("import './construction-live-dependency'", source)
    const ctor = classes[0]!.members.find(ts.isConstructorDeclaration)!
    assert.ok(ctor)
    assert.equal(reachable.memberIsPruned(ctor), false)
  })
test('constructor discovered after initial class visit revisits instance initialization', () => {
  const source = `export class Dormant { static ready=1; value=lateEffect(); constructor(){lateEffect()} }
 function lateEffect(){console.log('late');return 1}
 export function create(){return new Dormant()}`
  const { reachable, classes, file } = inspect("import {create} from './construction-live-dependency';create()", source)
  const ctor = classes[0]!.members.find(ts.isConstructorDeclaration)!
  assert.equal(reachable.memberIsPruned(ctor), false)
  const field = classes[0]!.members.find(ts.isPropertyDeclaration)!
  assert.ok(field)
  assert.ok(reachable.statementsOf(file).some((item) => ts.isFunctionDeclaration(item) && item.name?.text === 'lateEffect'))
})

test('computed name exposes an already initialized constructor conservatively', () => {
  const source = `declare function consume(value:unknown):symbol;
 export class Existing { constructor(){console.log('constructed')} }
 export class Definition { [consume(Existing)](){return 1} }`
  const { reachable, classes } = inspect("import './construction-live-dependency'", source)
  const ctor = classes.find((item) => item.name?.text === 'Existing')!.members.find(ts.isConstructorDeclaration)!
  assert.equal(reachable.memberIsPruned(ctor), false)
})

for (const [name, entrySource, member] of [
  [
    'constructed body',
    "import {Dormant} from './construction-live-dependency';new Dormant()",
    'constructor(){Object.defineProperty(opaque,unknownKey,{value:1})}'
  ],
  ['static initializer', "import './construction-live-dependency'", 'static value=Object.defineProperty(opaque,unknownKey,{value:1});'],
  ['static block', "import './construction-live-dependency'", 'static {Object.defineProperty(opaque,unknownKey,{value:1})}']
] as const)
  test(`normal compiler preserves actual ${name} mutation obligations`, () => {
    const source = `declare const opaque:object;declare const unknownKey:string;const key=Symbol('computed');
 export class Dormant{[key](){return 1};${member}}`
    const result = compile(input(entrySource, source))
    assert.equal(result.source, null)
    assert.ok(result.refusals.length > 0)
  })

for (const [name, source] of [
  [
    'opaque namespace escape',
    "import * as namespace from './construction-live-dependency';declare function accept(value:unknown):void;accept(namespace)"
  ],
  ['exported namespace escape', "export * as namespace from './construction-live-dependency'"]
] as const)
  test(`${name} conservatively retains dependency constructors`, () => {
    const { reachable, classes } = inspect(source)
    for (const item of classes) {
      const ctor = item.members.find(ts.isConstructorDeclaration)!
      assert.equal(reachable.memberIsPruned(ctor), false, item.name?.text)
    }
  })

test('escaped cyclic module namespace closes its exported constructor inventory', () => {
  const { reachable, classes } = inspect(
    "import * as namespace from './construction-live-dependency';declare function accept(value:unknown):void;accept(namespace)",
    declaration + "\nexport * as recursive from './construction-live-dependency'"
  )
  for (const item of classes) assert.equal(reachable.memberIsPruned(item.members.find(ts.isConstructorDeclaration)!), false)
})
test('a default constructor reexport remains an escaped constructor', () => {
  const { reachable, classes } = inspect(
    "export {default as Public} from './construction-live-dependency'",
    "export default class Dormant {constructor(){console.log('constructed')}}"
  )
  assert.equal(reachable.memberIsPruned(classes[0]!.members.find(ts.isConstructorDeclaration)!), false)
})

for (const [name, typeExport] of [
  ['named type export', "export type {Hidden} from './construction-type-only-hidden'"],
  ['type namespace export', "export type * as hidden from './construction-type-only-hidden'"],
  ['type star export', "export type * from './construction-type-only-hidden'"],
  ['nested star type export', "export * from './construction-type-only-barrel'"],
  ['local type import alias', "import type {Hidden as Local} from './construction-type-only-hidden';export {Local as Hidden}"]
] as const)
  test(`${name} does not evaluate a hidden module through a runtime namespace escape`, () => {
    const hidden = resolve('test/fixtures/construction-type-only-hidden.ts')
    const request = input(
      "import * as namespace from './construction-live-dependency';declare function accept(value:unknown):void;accept(namespace)",
      typeExport + ';export const visible=1'
    )
    request.sourceOverlay.set(
      resolve('test/fixtures/construction-type-only-barrel.ts'),
      "export type {Hidden} from './construction-type-only-hidden'"
    )
    request.sourceOverlay.set(
      hidden,
      "export class Hidden { static effect=console.log('TYPE_ONLY_HIDDEN_DEFINITION_MUST_NOT_RUN');constructor(){console.log('hidden-construction')} }"
    )
    const result = createProgram(request)
    const reachable = censusReachability({
      checker: result.checker,
      files: result.sourceFiles,
      entries: result.entryFiles,
      runtimeExportOf: (file, name) => result.runtimeExportOf(file.fileName, name)
    })
    const file = result.program.getSourceFile(hidden)!
    assert.ok(file)
    assert.deepEqual(reachable.statementsOf(file), [], 'type-only export must not schedule actual hidden-module definition effects')
    const owner = file.statements.find(ts.isClassDeclaration)!
    assert.ok(owner)
    assert.equal(reachable.memberIsPruned(owner.members.find(ts.isConstructorDeclaration)!), true)
  })

for (const [name, barrelSource] of [
  ['direct dual-space barrel', "export type {Foo} from './construction-space-types';export * from './construction-space-values'"],
  ['nested star dual-space barrel', "export * from './construction-space-inner'"],
  ['renamed dual-space barrel', "export {Foo as Foo} from './construction-space-inner'"]
] as const)
  test(`${name} exposes the canonical value constructor without evaluating the type module`, () => {
    const types = resolve('test/fixtures/construction-space-types.ts'),
      values = resolve('test/fixtures/construction-space-values.ts')
    const request = input(
      "import * as namespace from './construction-live-dependency';declare function accept(value:unknown):void;accept(namespace)",
      barrelSource
    )
    request.sourceOverlay.set(
      types,
      "export class Foo {static effect=console.log('TYPE_SPACE_MUST_NOT_RUN');constructor(){console.log('type-body')}}"
    )
    request.sourceOverlay.set(
      values,
      "export class Foo {static effect=console.log('VALUE_SPACE_DEFINITION');constructor(){console.log('value-body')}}"
    )
    request.sourceOverlay.set(
      resolve('test/fixtures/construction-space-inner.ts'),
      "export type {Foo} from './construction-space-types';export * from './construction-space-values'"
    )
    const result = createProgram(request)
    assert.deepEqual(result.diagnostics, [], 'the combined type/value export is valid TypeScript')
    const value = result.runtimeExportOf(dependency, 'Foo')
    assert.equal(value.kind, 'binding')
    assert.ok(value.kind === 'binding' && value.symbol.declarations?.every((item) => item.getSourceFile().fileName === values))
    const reachable = censusReachability({
      checker: result.checker,
      files: result.sourceFiles,
      entries: result.entryFiles,
      runtimeExportOf: (file, key) => result.runtimeExportOf(file.fileName, key)
    })
    assert.deepEqual(reachable.statementsOf(result.program.getSourceFile(types)!), [], 'type-only module effects never enter evaluation')
    const file = result.program.getSourceFile(values)!
    const owner = file.statements.find(ts.isClassDeclaration)!
    assert.equal(
      reachable.memberIsPruned(owner.members.find(ts.isConstructorDeclaration)!),
      false,
      'the actual exported runtime constructor remains reachable'
    )
    assert.ok(reachable.statementsOf(file).includes(owner), 'actual value module definition effects remain')
  })

for (const [name, body] of [
  ['implicit constructor', ''],
  ['explicit super constructor', 'constructor(){super()}']
] as const)
  test(`live class expression ${name} retains base construction convention`, () => {
    const source = `export class Base {value=1;constructor(){console.log('base')}}
 const Derived=class extends Base {own(){return 2};${body}};new Derived()`
    const { reachable, classes } = inspect("import './construction-live-dependency'", source)
    const base = classes.find((item) => item.name?.text === 'Base')!
    assert.equal(reachable.memberIsPruned(base.members.find(ts.isConstructorDeclaration)!), false)
  })
test('normal compiler preserves class name/length and absent-default class-expression runtime fixture', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/class-name-length-and-absent-default.runtime.js')],
    projectFileName: null
  })
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals))
})

test('nested live class-expression heritage retains declared base constructor', () => {
  const { reachable, classes } = inspect(
    "import './construction-live-dependency'",
    "export class Base {value=1;constructor(){console.log('base')}};const Derived=class extends (class extends Base {inner(){return 2}}) {own(){return 3}};new Derived()"
  )
  assert.equal(reachable.memberIsPruned(classes[0]!.members.find(ts.isConstructorDeclaration)!), false)
})
