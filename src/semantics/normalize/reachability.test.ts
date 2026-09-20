import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { censusReachability } from './reachability.js'
import { compile } from '../../compiler.js'
import { runtimeClassLayoutsOf } from '../../projection/classes.js'

const entry = resolve('test/fixtures/erased-derived-entry.ts')
const base = resolve('test/fixtures/erased-derived-base.ts')
const derived = resolve('test/fixtures/erased-derived-class.ts')
const effect = resolve('test/fixtures/erased-derived-effect.ts')

const programInput = (source: string) => ({
  rootFileNames: [entry],
  projectFileName: null,
  options: { ...defaultCompilerOptions, types: [] },
  sourceOverlay: new Map([
    [entry, source],
    [base, `export class Base { amount = 7; } console.log('base module effect');`],
    [
      derived,
      `import { Base } from './erased-derived-base'; import { effect } from './erased-derived-effect'; export default class Derived extends Base { constructor(seed = effect()) { super(); effect(); } own() { effect(); return 9; } } effect();`
    ],
    [effect, `export function effect() { console.log('derived module effect'); } effect();`]
  ])
})

const inspect = (source: string) => {
  const result = createProgram(programInput(source))
  assert.deepEqual(
    result.diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')),
    []
  )
  const reachable = censusReachability({ checker: result.checker, files: result.sourceFiles, entries: result.entryFiles })
  return (file: string) => reachable.statementsOf(result.program.getSourceFile(file)!).map((statement) => statement.getText())
}

test('an inherited field read does not execute a type-only derived class module', () => {
  const statements = inspect(
    `import type Derived from './erased-derived-class'; export function read(value: Derived | null) { return value === null ? -1 : value.amount; } console.log(read(null), 'own');`
  )
  assert.equal(statements(derived).length, 1)
  assert.ok(statements(derived)[0]?.startsWith('export default class Derived'))
  assert.deepEqual(statements(effect), [])
  assert.deepEqual(statements(base), ['export class Base { amount = 7; }'])
})

test('constructing the derived class retains its constructor and module effects', () => {
  const statements = inspect(`import Derived from './erased-derived-class'; console.log(new Derived().amount);`)
  assert.ok(statements(derived).some((text) => text === 'effect();'))
  assert.ok(statements(effect).some((text) => text === 'effect();'))
  assert.ok(statements(base).some((text) => text.includes('base module effect')))
})

test('a directly called type-only method retains its implementation dependencies', () => {
  const statements = inspect(
    `import type Derived from './erased-derived-class'; export function read(value: Derived | null) { return value === null ? -1 : value.own(); } console.log(read(null));`
  )
  assert.ok(statements(effect).some((text) => text === 'effect();'))
  assert.equal(statements(derived).length, 1)
})

test('new through a typed constructor parameter demands its real constructor', () => {
  const statements = inspect(
    `import type Derived from './erased-derived-class'; export function create(ctor: typeof Derived) { return new ctor().amount; }`
  )
  assert.ok(statements(derived).some((text) => text === 'effect();'))
  assert.ok(statements(effect).some((text) => text === 'effect();'))
})

test('a type-only derived receiver retains a valid native inherited field layout', () => {
  const result = compile(
    programInput(
      `import type Derived from './erased-derived-class'; export function read(value: Derived | null) { return value === null ? -1 : value.amount; } console.log(read(null));`
    )
  )
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals.filter((item) => item.stage !== 'census')))
  for (const layout of result.projection.classes.values()) {
    assert.equal(layout.layoutOnly, true)
    assert.equal(layout.construct, null, 'a shape-only class must not claim a construction recipe')
    assert.equal(layout.constructor, null, 'no empty constructor stub may be published')
  }
  const native = spawnSync(
    process.env['CXX'] ?? 'clang++',
    ['-std=c++20', '-fsyntax-only', '-I', resolve('src/targets/cpp/runtime'), '-x', 'c++', '-'],
    { input: result.source, encoding: 'utf8' }
  )
  assert.equal(native.status, 0, native.stderr)
})

test('dynamic constructor reads consider runtime classes while keeping unused subtype layouts', () => {
  const input = programInput(
    `import { Base } from './erased-derived-base'; import type Derived from './erased-derived-class'; export function read(value: Derived | null) { return value === null ? -1 : value.amount; } const original = new Base(); console.log(original.clone().amount, read(null));`
  )
  input.sourceOverlay.set(base, `export class Base { amount = 7; clone(): Base { return new this.constructor(); } }`)
  const result = compile(input)
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals.filter((item) => item.stage !== 'census')))
  assert.equal(runtimeClassLayoutsOf(result.projection.classes).length, 1)
  assert.ok([...result.projection.classes.values()].some((layout) => layout.layoutOnly))
  const native = spawnSync(
    process.env['CXX'] ?? 'clang++',
    ['-std=c++20', '-fsyntax-only', '-I', resolve('src/targets/cpp/runtime'), '-x', 'c++', '-'],
    { input: result.source, encoding: 'utf8' }
  )
  assert.equal(native.status, 0, native.stderr)
})

// Three's universal `clone() { return new this.constructor().copy( this ) }`
// idiom (Object3D/Material/Texture/Camera/BufferGeometry/RenderTarget): a
// subclass never literally `new`'d anywhere -- reached only through the
// family `new this.constructor()` closes over `extends` -- still overrides
// `copy`, and `.copy(this)`'s own dispatch has to reach that override at
// runtime. Unlike the bare `return new this.constructor()` case above, this
// shape DOES need the family member fully live: it is not enough to keep the
// subtype's LAYOUT around, its `copy` body has to exist for the dispatch to
// call into.
const cloneFamilyEntry = resolve('test/fixtures/clone-idiom-family-reachability.ts')
const cloneFamilyInput = (source: string) => ({
  rootFileNames: [cloneFamilyEntry],
  projectFileName: null,
  options: { ...defaultCompilerOptions, types: [] },
  sourceOverlay: new Map([[cloneFamilyEntry, source]])
})
// Three spells the JSDoc-cast form of the idiom in plain `.js` files (Texture.js,
// BufferGeometry.js, Object3D.js, Camera.js): TypeScript applies a JSDoc `@type`
// cast only under `checkJs` on a `.js` source -- inside a `.ts` file the same
// comment is inert and `this.constructor` stays typed `Function`, which has no
// construct signature and makes the fixture fail on an unrelated checker
// diagnostic ("not constructable") rather than exercise the shape under test.
const cloneFamilyJsEntry = resolve('test/fixtures/clone-idiom-family-reachability.js')
const cloneFamilyJsInput = (source: string) => ({
  rootFileNames: [cloneFamilyJsEntry],
  projectFileName: null,
  options: { ...defaultCompilerOptions, types: [] },
  sourceOverlay: new Map([[cloneFamilyJsEntry, source]])
})

test('a copy override reached only through new this.constructor().copy(this) is fully live, not layout-only', () => {
  const result = compile(
    cloneFamilyInput(`
      class Base {
        copy(s: Base) { return this }
        clone() { return new this.constructor().copy(this) }
      }
      class Dead extends Base {
        copy(s: Dead) { super.copy(s); return this }
      }
      function main() { const b = new Base(); b.clone() }
      main()
    `)
  )
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals.filter((item) => item.stage !== 'census')))
  assert.ok(
    ![...result.projection.classes.values()].some((layout) => layout.layoutOnly),
    'Dead is dispatched through .copy(this) and must not stay a shape-only layout'
  )
  const native = spawnSync(
    process.env['CXX'] ?? 'clang++',
    ['-std=c++20', '-fsyntax-only', '-I', resolve('src/targets/cpp/runtime'), '-x', 'c++', '-'],
    { input: result.source, encoding: 'utf8' }
  )
  assert.equal(native.status, 0, native.stderr)
})

test('the JSDoc type-cast spelling of the clone idiom also keeps its family fully live', () => {
  // Texture.js, BufferGeometry.js, Object3D.js and Camera.js all spell the
  // idiom behind a JSDoc `@type` cast paren purely to anchor the comment:
  // `new ( /** @type {new (...args: any[]) => this} */ ( this.constructor ) )()`.
  // Plain JS (no `: Type` annotations) on a `.js` entry, matching how three
  // itself is authored and the only shape that makes checkJs apply the cast.
  const result = compile(
    cloneFamilyJsInput(`
      class Base {
        /** @param {Base} s */
        copy(s) { return this }
        clone() { return new ( /** @type {new (...args: any[]) => this} */ ( this.constructor ) )().copy(this) }
      }
      class Dead extends Base {
        /** @param {Dead} s */
        copy(s) { super.copy(s); return this }
      }
      function main() { const b = new Base(); b.clone() }
      main()
    `)
  )
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals.filter((item) => item.stage !== 'census')))
  assert.ok(
    ![...result.projection.classes.values()].some((layout) => layout.layoutOnly),
    'Dead is dispatched through .copy(this) and must not stay a shape-only layout'
  )
})
