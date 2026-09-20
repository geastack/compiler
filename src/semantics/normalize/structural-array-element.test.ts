import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusCollectionBindings } from './collection-bindings.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { inferredArrayElementAt } from './structural-array-element.js'
import { createIdentityTable } from './identities.js'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createStructuralMapper } from './structural.js'

test('an inferred array keeps its alias write-set carrier at concrete earlier checker reads', () => {
  const entry = resolve('test/fixtures/inferred-array-publication.ts')
  const source = `function create() {
    const values = [];
    for (let index = 0; index < 3; index++) values[index] = 0;
    return { values: values };
  }
  const state = create();
  function write(index: number, value: number | undefined) { state.values[index] = value }
  write(0, undefined);
  const alias = state.values;
  alias[0];
  let position = 0;
  const first = []; first[position] = 1;
  const second = []; second[position] = 'x';
  function mutate(items) { items[position] = undefined }
  mutate(first); mutate(second);
  const stated: number[] = [];
  stated.push(1);`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const collections = censusCollectionBindings(checker, [file], wholeProgram, emptyParameterBindingCensus, flow)
  const declarations: ts.VariableDeclaration[] = []
  const reads: ts.Identifier[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node)
    if (ts.isIdentifier(node) && ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) reads.push(node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  const declaration = declarations.find((item) => item.name.getText() === 'values')!
  const read = reads[0]!
  assert.equal(checker.typeToString(checker.getTypeAtLocation(read)), 'number[]')
  const census = collections.arrayElementForOwner(declaration)
  assert.ok(census)
  assert.equal(checker.typeToString(census), 'number | undefined')
  const typeAt = (node: ts.Node) => checker.getTypeAtLocation(node)
  assert.equal(inferredArrayElementAt(checker, collections, typeAt, declaration), census)
  assert.equal(inferredArrayElementAt(checker, collections, typeAt, declaration.initializer!), census)
  assert.equal(inferredArrayElementAt(checker, collections, typeAt, read), census)
  const alias = declarations.find((item) => item.name.getText() === 'alias')!
  assert.equal(collections.arrayElementForOwner(alias), census)
  assert.equal(collections.arrayElementForRead(alias.initializer as ts.Expression), census)
  assert.equal(inferredArrayElementAt(checker, collections, typeAt, alias), census)
  const table = createStructuralTypeTable()
  const mapper = createStructuralMapper(
    checker,
    createIdentityTable(program, checker),
    table,
    undefined,
    undefined,
    undefined,
    undefined,
    collections
  )
  const record = table.get(mapper.typeAt(read.parent.parent)).shape
  assert.equal(record.kind, 'object')
  if (record.kind === 'object') {
    const member = record.members.find((item) => item.key.kind === 'string' && item.key.value === 'values')
    assert.ok(member)
    assert.equal(member.type, mapper.typeAt(read))
    assert.equal(member.type, mapper.typeAt(alias.initializer!))
  }
  const first = declarations.find((item) => item.name.getText() === 'first')!
  const second = declarations.find((item) => item.name.getText() === 'second')!
  const shared = collections.arrayElementForOwner(first)
  assert.ok(shared)
  assert.equal(collections.arrayElementForOwner(second), shared)
  assert.equal(checker.typeToString(shared), 'string | number | undefined')
  const stated = declarations.find((item) => item.name.getText() === 'stated')!
  assert.equal(inferredArrayElementAt(checker, collections, typeAt, stated), null)
  assert.equal(inferredArrayElementAt(checker, collections, typeAt, stated.name), null)
})
