import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'
import { sameImplicitArgumentsTuple } from './implicit-arguments-tuple.js'

/**
 * A graphics library's forwarding shims, reduced: `function texImage3D() {
 * gl.texImage3D( ...arguments ) }`, called with numbers in its leading
 * positions and a typed array or `null` in its last.
 */
const censusOf = (body: string) => {
  const entry = resolve('test/fixtures/implicit-arguments-tuple.js')
  const source = `export {};
    function upload( target, level, data ) {
      return data === null ? target : level;
    }
    ${body}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  // The fixture is the whole program (see mutable-method-parameters.test.ts).
  const valueFlow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(valueFlow, { files: new Set([file]) })
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, valueFlow)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index, valueFlow)
  // Nested too: such shims are inner functions of a factory
  // (`GpuState` declares `texImage3D` inside itself), and a finder over
  // top-level statements alone hands `implicitArgumentsTupleAt` nothing.
  const functionNamed = (name: string): ts.FunctionDeclaration => {
    let found: ts.FunctionDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found ??= node
      ts.forEachChild(node, visit)
    }
    visit(file)
    return found!
  }
  const spelled = (type: ts.Type | null): readonly string[] | null =>
    type === null ? null : (type.isUnion() ? type.types : [type]).map((part) => checker.typeToString(part)).sort()
  const frameOf = (name: string) => census.implicitArgumentsTupleAt?.(functionNamed(name)) ?? null
  const readsIn = (name: string): ts.ElementAccessExpression[] => {
    const reads: ts.ElementAccessExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'arguments') reads.push(node)
      ts.forEachChild(node, visit)
    }
    visit(functionNamed(name))
    return reads
  }
  return { census, spelled, frameOf, readsIn }
}

const callers = 'texImage3D( 1, 0, new Uint8Array( 4 ) ); texImage3D( 2, 1, null ); texImage3D( 3, 2 );'

test('equal checker frame types cannot hide a changed prototype-versus-instance source inventory', () => {
  const { frameOf } = censusOf(`function read(value) { return arguments.length; } read(Date.prototype); read(new Date());`)
  const frame = frameOf('read')
  assert.ok(frame && frame.frame === 'array' && frame.sourcePositions)
  const sources = frame.sourcePositions[0]!
  assert.equal(sources.length, 2)
  assert.equal(sources[0]!.getText(), 'Date.prototype')
  assert.equal(sources[1]!.getText(), 'new Date()')
  assert.equal(sameImplicitArgumentsTuple(frame, { ...frame, sourcePositions: [[...sources]] }), true)
  assert.equal(sameImplicitArgumentsTuple(frame, { ...frame, sourcePositions: [[sources[0]!, sources[0]!]] }), false)
})

test('a forwarded arguments frame is typed per position over its closed callers', () => {
  const { frameOf, spelled } = censusOf(`function texImage3D() { upload( ...arguments ); } ${callers}`)
  const frame = frameOf('texImage3D')
  assert.ok(frame && frame.frame === 'tuple', 'a final spread into a fixed convention reads fixed positions')
  assert.deepEqual(frame.elements.slice(0, 2).map(spelled), [['number'], ['number']])
  // The last position keeps its own join rather than one element type over all three.
  const last = spelled(frame.elements[2] ?? null) ?? []
  assert.ok(
    last.some((part) => part.startsWith('Uint8Array')),
    last.join('|')
  )
  assert.ok(last.includes('null'), last.join('|'))
  assert.ok(!last.includes('number'), last.join('|'))
  // One caller omits the last position, so it is optional.
  assert.equal(frame.required, 2)
})

test('a literal read of a positional frame reads that position, and undefined where a caller omits it', () => {
  const { census, frameOf, readsIn, spelled } = censusOf(
    `function texImage3D() { return arguments[ 0 ] + ( arguments[ 2 ] === null ? 1 : 0 ); } ${callers}`
  )
  assert.equal(frameOf('texImage3D')?.frame, 'tuple')
  const [first, last] = readsIn('texImage3D')
  assert.deepEqual(spelled(census.typeAt(first!)), ['number'])
  const lastRead = spelled(census.typeAt(last!)) ?? []
  assert.ok(lastRead.includes('undefined') && lastRead.includes('null'), lastRead.join('|'))
})

test('a frame read at a runtime index keeps the runtime-sized array of one element', () => {
  const { frameOf, spelled } = censusOf(`
    function sum() { let total = 0; for ( let i = 0; i < arguments.length; i ++ ) total += arguments[ i ]; return total; }
    sum( 1, 2 ); sum( 3 );`)
  const frame = frameOf('sum')
  assert.ok(frame && frame.frame === 'array')
  assert.deepEqual(spelled(frame.element), ['number'])
})

test('the actual arguments frame includes supplied values but does not reject omitted named formals', () => {
  const { frameOf, spelled } = censusOf(`
    function count(first, second, third) { return arguments.length; }
    count(); count(undefined); count(null); count(1, 2); count(3, 4, 5);`)
  const frame = frameOf('count')
  assert.ok(frame && frame.frame === 'array')
  assert.deepEqual(spelled(frame.element), ['null', 'number', 'undefined'])
})

/**
 * The full library shape: `GpuState` publishes the shim on a returned record,
 * the renderer keeps that record in a cell, hands it to `GpuTextures` (whose
 * uploads are the only callers) and stores it on a field other code reads
 * members through.
 */
const handedOn = (tail: string) => `
  function GpuState() {
    function texImage3D() { upload( ...arguments ); }
    function bindTexture( target ) { return target; }
    return { texImage3D: texImage3D, bindTexture: bindTexture };
  }
  function GpuTextures( state ) {
    function uploadTexture() { state.bindTexture( 1 ); state.texImage3D( 1, 0, new Uint8Array( 4 ) ); state.texImage3D( 2, 1, null ); }
    return { uploadTexture };
  }
  class Renderer {
    constructor() {
      const _this = this;
      let state;
      state = new GpuState();
      const textures = new GpuTextures( state );
      _this.state = state;
      this.textures = textures;
    }
  }
  const renderer = new Renderer();
  renderer.textures.uploadTexture();
  const _state = renderer.state;
  _state.bindTexture( 2 );
  ${tail}`

test('a published shim handed on through a parameter and a field keeps its closed callers', () => {
  const { frameOf, spelled } = censusOf(handedOn(''))
  const frame = frameOf('texImage3D')
  assert.ok(frame && frame.frame === 'tuple', 'the record reaches only member calls')
  assert.deepEqual(frame.elements.slice(0, 2).map(spelled), [['number'], ['number']])
})

test('a published shim whose record escapes anywhere along the way keeps refusing', () => {
  for (const leak of [
    'globalThis.unknownConsumer( renderer.state );',
    'globalThis.unknownConsumer( _state );',
    'globalThis.unknownConsumer( renderer.state.texImage3D );',
    'globalThis.unknownConsumer( renderer );'
  ])
    assert.equal(censusOf(handedOn(leak)).frameOf('texImage3D'), null, leak)
})

test('an open caller set keeps refusing', () => {
  const { frameOf } = censusOf(`function texImage3D() { upload( ...arguments ); } ${callers} globalThis.unknownConsumer( texImage3D );`)
  assert.equal(frameOf('texImage3D'), null)
})

test('a spread that is not a fixed positional fill keeps refusing', () => {
  // Into a rest formal: the split between named formals and the packed tail is a runtime fact.
  const rest = censusOf(`function gather( ...values ) { return values; } function texImage3D() { gather( ...arguments ); } ${callers}`)
  assert.equal(rest.frameOf('texImage3D'), null)
  // Not the last argument: the written argument after it lands where only the frame's length knows.
  const trailing = censusOf(`function texImage3D() { upload( ...arguments, 1 ); } ${callers}`)
  assert.equal(trailing.frameOf('texImage3D'), null)
  // Handed on whole: the object escapes every read this fact describes.
  const escaped = censusOf(`function texImage3D() { globalThis.unknownConsumer( arguments ); } ${callers}`)
  assert.equal(escaped.frameOf('texImage3D'), null)
})
