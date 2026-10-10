import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createIdentityTable } from './identities.js'
import { createStructuralMapper } from './structural.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'
import { createMutableFieldResolver } from './structural-mutable-field.js'

const inspect = (source: string) => {
  const entry = resolve('test/runtime/typed-shared-view-preserves-field-aliases.runtime.ts')
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  assert.equal(program.getSemanticDiagnostics().filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length, 0)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const table = createStructuralTypeTable()
  const mapper = createStructuralMapper(
    checker,
    createIdentityTable(program, checker),
    table,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    flow
  )
  const access = (text: string): ts.PropertyAccessExpression => {
    let found: ts.PropertyAccessExpression | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.getText(file) === text) found = node
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(found, text)
    return found
  }
  const field = (owner: string): ts.PropertyDeclaration => {
    let found: ts.PropertyDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name?.text === owner)
        found = node.members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member))
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(found, owner)
    return found
  }
  const members = (value: ReturnType<typeof mapper.typeAt>): readonly string[] => {
    const shape = table.get(value).shape
    if (shape.kind === 'union') return [...new Set(shape.members.flatMap(members))].sort()
    if (shape.kind === 'primitive') return [shape.primitive]
    if (shape.kind === 'literal') return [shape.primitive]
    return [shape.kind]
  }
  return { checker, mapper, table, flow, ledger, access, field, members }
}

test('an actual write through structural aliases broadens the original data cell and every alias read', () => {
  const { mapper, checker, ledger, field, access, members } = inspect(`
    class Origin { shown = 'initial'; }
    const original = new Origin();
    const view: { shown: string | number } = original;
    const chain: { shown: string | number } = view;
    chain.shown = 42;
    original.shown; view.shown; chain.shown;
  `)
  const declaration = field('Origin')
  const symbol = checker.getSymbolAtLocation(declaration.name)!
  const floor = mapper.typeOf(checker.getTypeOfSymbolAtLocation(symbol, declaration))
  const held = ledger.capture(() => mapper.mutableFieldStorageTypeOf(symbol, floor)).value
  assert.ok(held)
  assert.deepEqual(members(held), ['number', 'string'])
  for (const name of ['original', 'view', 'chain'])
    assert.deepEqual(members(ledger.capture(() => mapper.typeAt(access(`${name}.shown`))).value), ['number', 'string'], name)
})

test('erased literal keys still nominate the exact data slot and its actual writer', () => {
  const { mapper, checker, ledger, field, access, members } = inspect(`
    class Origin { shown = 'initial'; }
    const original = new Origin();
    const view: { shown: string | number } = original;
    view['shown' as 'shown'] = 42;
    original.shown;
  `)
  const declaration = field('Origin')
  const symbol = checker.getSymbolAtLocation(declaration.name)!
  const storage = ledger.capture(() =>
    mapper.mutableFieldStorageTypeOf(symbol, mapper.typeOf(checker.getTypeOfSymbolAtLocation(symbol, declaration)))
  ).value
  assert.ok(storage)
  assert.deepEqual(members(storage), ['number', 'string'])
  assert.deepEqual(members(ledger.capture(() => mapper.typeAt(access('original.shown'))).value), ['number', 'string'])
})

test('a parameter-property read stays with its existing declaration authority without a new origin query', () => {
  const { mapper, access } = inspect(`
    class Origin { constructor(public shown: string) {} }
    const original = new Origin('initial');
    const view: { shown: string } = original;
    view.shown = 'changed';
    original.shown;
  `)
  assert.equal(mapper.mutableFieldReadTypeAt(access('original.shown')), null)
})

test('a wider public view alone never invents a writer or broadens unrelated class slots', () => {
  const { mapper, checker, ledger, field, access, members } = inspect(`
    class Origin { shown = 'initial'; }
    class Other { shown = 'other'; }
    const original = new Origin();
    const unrelated = new Other();
    const view: { shown: string | number } = original;
    view.shown; unrelated.shown;
  `)
  for (const owner of ['Origin', 'Other']) {
    const declaration = field(owner)
    const symbol = checker.getSymbolAtLocation(declaration.name)!
    const floor = mapper.typeOf(checker.getTypeOfSymbolAtLocation(symbol, declaration))
    assert.equal(ledger.capture(() => mapper.mutableFieldStorageTypeOf(symbol, floor)).value, null)
  }
  assert.deepEqual(members(mapper.typeAt(access('unrelated.shown'))), ['string'])
  assert.deepEqual(members(mapper.typeAt(access('view.shown'))), ['number', 'string'])
})

test('closed generic allocation copies use their instantiated field floor for actual alias writes', () => {
  const { mapper, table, ledger, access } = inspect(`
    class Cell<T> { items: T[] = []; }
    const original = new Cell<string>();
    const unrelated = new Cell<boolean>();
    const view: { items: string[] | number[] } = original;
    view.items = [42];
    original.items; unrelated.items;
  `)
  const widened = ledger.capture(() => mapper.mutableFieldReadTypeAt(access('original.items'))).value
  assert.ok(widened)
  const shape = table.get(widened).shape
  assert.equal(shape.kind, 'union')
  if (shape.kind !== 'union') return
  const elements = shape.members.map((member) => {
    const array = table.get(member).shape
    assert.equal(array.kind, 'array')
    const element = table.get(array.element).shape
    return element.kind === 'primitive' ? element.primitive : element.kind
  })
  assert.deepEqual([...new Set(elements)].sort(), ['number', 'string'])
  assert.equal(ledger.capture(() => mapper.mutableFieldReadTypeAt(access('unrelated.items'))).value, null)
})

test('a source root still containing a foreign generic array is refused before its field type is interned', () => {
  const { checker, mapper, table, flow, ledger, access } = inspect(`
    class Cursor<T> {
      items: T[] = [];
      constructor(items: T[]) { this.items = items; }
    }
    function create<T>(items: T[]) {
      const cursor = new Cursor<T>(items);
      cursor.items;
      return cursor;
    }
    create<string>(['one']);
  `)
  const nominated: string[] = []
  const resolver = createMutableFieldResolver(
    checker,
    table,
    flow,
    (type) => {
      nominated.push(checker.typeToString(type))
      return mapper.typeOf(type)
    },
    mapper.typeAt
  )
  assert.equal(ledger.capture(() => resolver.readTypeAt(access('cursor.items'))).value, null)
  assert.deepEqual(nominated, [])
})

test('an opaque mutation withdraws the closed source slot family', () => {
  const { mapper, checker, ledger, field } = inspect(`
    class Origin { shown = 'initial'; }
    const original = new Origin();
    const view: { shown: string | number } = original;
    view.shown = 42;
    declare function mutate(value: unknown): void;
    mutate(view);
  `)
  const declaration = field('Origin')
  const symbol = checker.getSymbolAtLocation(declaration.name)!
  const floor = mapper.typeOf(checker.getTypeOfSymbolAtLocation(symbol, declaration))
  assert.equal(ledger.capture(() => mapper.mutableFieldStorageTypeOf(symbol, floor)).value, null)
})
