import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../../compiler.js'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createIdentityTable } from './identities.js'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { createStructuralMapper } from './structural.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'
import type { StructuralTypeId } from '../../identity/ids.js'

const inspect = (body: string) => {
  const entry = resolve('test/fixtures/structural-implicit-arguments.js')
  const source = `export {}; ${body}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(flow, { files: new Set([file]) })
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, flow)
  const parameters = censusParameterBindings(checker, [file], wholeProgram, undefined, index, flow)
  const table = createStructuralTypeTable()
  const identities = createIdentityTable(program, checker)
  const mapper = createStructuralMapper(checker, identities, table, undefined, undefined, parameters, undefined, undefined, undefined, flow)
  const named = (name: string): ts.FunctionDeclaration => {
    const declaration = file.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    assert.ok(declaration && ts.isFunctionDeclaration(declaration))
    return declaration
  }
  const arms = (id: StructuralTypeId): readonly StructuralTypeId[] => {
    const shape = table.get(id).shape
    return shape.kind === 'union' ? shape.members.flatMap(arms) : [id]
  }
  const frameElement = (name: string) => {
    const declaration = named(name)
    const signature = checker.getSignatureFromDeclaration(declaration)
    assert.ok(signature)
    const shape = table.get(mapper.resolvedSignatureTypeOf(signature, 'call')).shape
    assert.equal(shape.kind, 'signature')
    if (shape.kind !== 'signature') throw new Error('source frame was not a signature')
    const frame = shape.call[0]!.parameters.find((parameter) => parameter.argumentsFrame === 'actual')
    assert.ok(frame, 'the same admitted actual-arguments convention must survive source mapping')
    const array = table.get(frame.type).shape
    assert.equal(array.kind, 'array')
    if (array.kind !== 'array') throw new Error('source frame was not an array')
    return arms(array.element)
  }
  return { checker, table, mapper, parameters, named, arms, frameElement }
}

test('a complete actual-arguments frame retains a Date method receiver beside ordinary source arms', () => {
  const { table, frameElement } = inspect(`
    function read(value) { return arguments.length; }
    read(Date.prototype.getTime); read('text'); read({ tag: 1 });
  `)
  const shapes = frameElement('read').map((id) => table.get(id).shape)
  const method = shapes.find((shape) => shape.kind === 'signature')
  assert.ok(method && method.kind === 'signature')
  const receiver = method.call[0]!.thisParameter
  assert.ok(receiver)
  assert.deepEqual(table.get(receiver).shape, { kind: 'primitive', primitive: 'any' })
  assert.ok(shapes.some((shape) => shape.kind === 'primitive' && shape.primitive === 'string'))
  assert.ok(
    shapes.some(
      (shape) => shape.kind === 'object' && shape.members.some((member) => member.key.kind === 'string' && member.key.value === 'tag')
    )
  )
})

test('repeated forwarding retains every prototype/ordinary arm without borrowing a sibling recursion guard', () => {
  const { mapper, table, named, arms } = inspect(`
    function read(value) { return arguments.length; }
    function forward(value) { read(value); read(value); }
    forward(Date.prototype); forward('text');
  `)
  const parameter = named('read').parameters[0]!
  const shapes = arms(mapper.typeAt(parameter)).map((id) => table.get(id).shape)
  const prototype = shapes.find((shape) => shape.kind === 'declared')
  assert.ok(prototype && prototype.kind === 'declared' && prototype.body !== null)
  const body = table.get(prototype.body).shape
  assert.ok(body.kind === 'object' && body.members.some((member) => member.key.kind === 'string' && member.key.value === 'getTime'))
  assert.ok(shapes.some((shape) => shape.kind === 'literal' && shape.primitive === 'string' && shape.text === 'text'))
})

test('a Math singleton and the actual descriptor source retain their own identities in the frame', () => {
  const { table, frameElement, mapper, parameters, named } = inspect(`
    function read(owner, descriptor) { return arguments.length; }
    const descriptor = Object.getOwnPropertyDescriptor(Math, 'abs');
    read(Math, descriptor);
  `)
  const frame = parameters.implicitArgumentsTupleAt?.(named('read'))
  assert.ok(frame?.sourcePositions)
  const sourceIds = frame.sourcePositions.flat().map((source) => mapper.typeAt(source))
  const selected = new Set(frameElement('read'))
  for (const sourceId of sourceIds) {
    const shape = table.get(sourceId).shape
    for (const id of shape.kind === 'union' ? shape.members : [sourceId]) assert.ok(selected.has(id))
  }
  assert.ok([...selected].some((id) => table.get(id).shape.kind === 'declared'))
  assert.ok(
    [...selected].some((id) => {
      const shape = table.get(id).shape
      return shape.kind === 'primitive' && shape.primitive === 'undefined'
    })
  )
})

test('an exposed actual-arguments body cannot publish a closed source frame', () => {
  const { parameters, named } = inspect(`
    function read(value) { return arguments.length; }
    function publish(value) { globalThis.saved = value; }
    publish(read); read(Date.prototype);
  `)
  assert.equal(parameters.implicitArgumentsTupleAt?.(named('read')) ?? null, null)
})

for (const file of [
  'property-helper-date-prototype-length.runtime.js',
  'property-helper-date-prototype-name.runtime.js',
  'property-helper-date-prototype-own.runtime.js',
  'property-helper-math-abs.runtime.js',
  'property-helper-math-sqrt2.runtime.js'
])
  test(`complete source frame transport certifies ${file}`, () => {
    const result = compile({
      rootFileNames: [resolve('test/runtime', file)],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      closedScriptScope: true
    })
    assert.equal(result.certification?.certified, true, JSON.stringify(result.certification?.refusals))
    assert.equal(result.source !== null, true, JSON.stringify(result.emissionRefusals))
  })
