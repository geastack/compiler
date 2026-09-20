import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { ownedClassReceiverInventoryOf } from './owned-class-receivers.js'
import { constructorCallsOf } from './parameter-values.js'

const inventoryOf = (extra = '', members = '') => {
  const entry = resolve('test/fixtures/owned-class-receivers.ts')
  const source = `export {}; declare function external(value: unknown): void;
    class Owner {
      self = this;
      captured = () => this;
      static unrelated = () => this;
      constructor() { const alias = this; }
      unused() { return this; }
      ${members}
    }
    class Child extends Owner { childSelf = this; }
    const first = new Owner();
    const second = new Child();
    ${extra}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const owner = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Owner')!
  return { flow, inventory: ownedClassReceiverInventoryOf(checker, flow, new Set([owner])) }
}

test('receiver inventory includes constructor and lexical field initializers of every constructed subclass', () => {
  const { inventory } = inventoryOf()
  assert.ok(inventory)
  assert.deepEqual(
    [...inventory.classes].map((owner) => owner.name?.text),
    ['Owner', 'Child']
  )
  assert.equal(inventory.constructionFacts.length, 2)
  assert.equal(inventory.initializers.flatMap((initializer) => initializer.references).length, 4)
  assert.ok(inventory.initializers.every((initializer) => !ts.isMethodDeclaration(initializer.member)))
  assert.ok(
    inventory.initializers.every((initializer) => (ts.getCombinedModifierFlags(initializer.member) & ts.ModifierFlags.Static) === 0)
  )
})

test('a hidden subclass constructor escape is retained even without a visible instance or method call', () => {
  const { flow, inventory } = inventoryOf('class Hidden extends Owner {} external(Hidden);')
  assert.equal(flow.classDeclarations.length, 3)
  assert.equal(inventory, null)
})

test('strict constructor identity comparisons preserve the ownership inventory without admitting coercive uses', () => {
  assert.ok(inventoryOf('const same = Owner === Owner; const distinct = Owner !== null;').inventory)
  assert.equal(inventoryOf('const coerced = Owner == null;').inventory, null)
  assert.equal(inventoryOf('external(Owner); const same = Owner === Owner;').inventory, null)
})

test('subclass constructors returning alternate objects do not prove ownership of their result', () => {
  const { inventory } = inventoryOf('class Replacement extends Owner { constructor() { super(); return {} as Replacement; } }')
  assert.equal(inventory, null)
})

test('a subclass static initializer cannot publish its constructor through an unnamed receiver', () => {
  assert.equal(inventoryOf('class Hidden extends Owner { static leak = external(this); }').inventory, null)
  assert.equal(inventoryOf('class Hidden extends Owner { static { external(this); } }').inventory, null)
})

test('source static data reads do not expose their constructor while callable and receiver captures remain open', () => {
  assert.ok(inventoryOf('external(Owner.flag); external(Owner.direction);', 'static flag = true; static direction = {x: 1};').inventory)
  assert.equal(inventoryOf('external(Owner.selfType);', 'static selfType = this;').inventory, null)
  assert.equal(inventoryOf('Owner.invoke();', 'static invoke = function() { external(this); };').inventory, null)
  assert.equal(inventoryOf('external(Owner.tag);', 'static get tag() { external(this); return 1; }').inventory, null)
  assert.equal(inventoryOf('external(Owner.container);', 'static container = { owner: this };').inventory, null)
})

test('JavaScript static data assignments preserve constructor identity without admitting descriptor mutation', () => {
  for (const mutation of ['', 'Object.defineProperty(Owner, "direction", { get() { return {}; } });']) {
    const entry = resolve('test/fixtures/static-data-owner.js')
    const source = `export {}; class Direction { constructor() { this.x = 1; } }
      class Owner { hook() {} }
      Owner.direction = new Direction();
      Owner.enabled = true;
      const held = new Owner();
      const direction = Owner.direction;
      const enabled = Owner.enabled;
      ${mutation}`
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true }
    const host = ts.createCompilerHost(options)
    const read = host.getSourceFile.bind(host)
    host.getSourceFile = (name, version, ...rest) =>
      resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
    const program = ts.createProgram([entry], options, host)
    const checker = program.getTypeChecker()
    const flow = indexValueFlow(checker, [program.getSourceFile(entry)!], wholeProgram)
    const owner = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Owner')!
    assert.equal(ownedClassReceiverInventoryOf(checker, flow, new Set([owner])) !== null, mutation === '')
  }
})

test('source constructor selections retain allocations hidden by result assertions', () => {
  const cast = inventoryOf('class Other {} const hidden = new (Owner as unknown as typeof Other)(); external(hidden);').inventory
  assert.ok(cast)
  assert.equal(cast.constructionFacts.length, 3)
  assert.ok(cast.constructionFacts.some(({ call }) => call.getText().includes('Owner as unknown')))
  const conditional = inventoryOf('declare const choose:boolean; const selected = new (choose ? Owner : Child)();').inventory
  assert.ok(conditional)
  assert.equal(conditional.constructionFacts.length, 3)
  const selected = conditional.constructionFacts.find(({ call }) => call.getText().includes('choose ? Owner : Child'))
  assert.deepEqual(
    selected?.alternatives.map((owner) => owner.name?.text),
    ['Owner', 'Child']
  )
  assert.deepEqual(
    selected?.familyProjection.map((owner) => owner.name?.text),
    ['Owner', 'Child']
  )

  const mixed = inventoryOf('declare const choose:boolean; class Other {} const selected = new (choose ? Owner : Other)();').inventory
  assert.ok(mixed)
  const mixedChoice = mixed.constructionFacts.find(({ call }) => call.getText().includes('choose ? Owner : Other'))
  assert.deepEqual(
    mixedChoice?.alternatives.map((owner) => owner.name?.text),
    ['Owner', 'Other']
  )
  assert.deepEqual(
    mixedChoice?.familyProjection.map((owner) => owner.name?.text),
    ['Owner']
  )
  assert.equal(
    inventoryOf('declare const choose:boolean; class Other {} external(Other); const selected = new (choose ? Owner : Other)();').inventory,
    null,
    'an alternative whose constructor escapes still keeps the whole choice open'
  )
  assert.equal(
    inventoryOf('class Other {} external(Owner); const hidden = new (Owner as unknown as typeof Other)();').inventory,
    null,
    'a checker-facing assertion must not hide a selected family constructor whose proof failed'
  )
  assert.equal(inventoryOf('declare const unknownConstructor:new()=>Owner; new unknownConstructor();').inventory, null)
})

test('constructor callers retain the exact family projection of a mixed source choice', () => {
  const entry = resolve('test/fixtures/conditional-constructor-callers.ts')
  const source = `export {};
    class First { constructor(value: number) {} }
    class Second { constructor(value: string) {} }
    const held = new (Math.random() ? First : Second)(1 as never);`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const declarations = flow.classDeclarations.filter(
    (declaration) => declaration.name?.text === 'First' || declaration.name?.text === 'Second'
  )
  assert.equal(declarations.length, 2)
  for (const declaration of declarations) {
    if (!('members' in declaration)) continue
    const constructor = declaration.members.find(ts.isConstructorDeclaration)
    assert.ok(constructor)
    const calls = constructorCallsOf(checker, flow, constructor)
    assert.equal(calls?.length, 1, declaration.name?.text)
    assert.equal(calls?.[0]?.getText(), 'new (Math.random() ? First : Second)(1 as never)')
  }
})
