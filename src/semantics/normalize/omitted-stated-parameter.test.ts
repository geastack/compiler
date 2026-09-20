import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * three's `ColorBuffer.setClear`, reduced: the declaration overlay states
 * `@param {boolean} premultipliedAlpha`, and `colorBuffer.setClear( 0, 0, 0,
 * 1 )` leaves it out.
 */
const bindingOf = (calls: string, statement = 'boolean') => {
  const entry = resolve('test/fixtures/omitted-stated-parameter.js')
  const source = `export {};
    /**
     * @param {number} r
     * @param {${statement}} premultipliedAlpha
     */
    function setClear( r, premultipliedAlpha ) {
      return premultipliedAlpha === true ? r * 2 : r;
    }
    ${calls}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const declaration = file.statements.find(ts.isFunctionDeclaration)!
  const parameter = declaration.parameters[1]!
  let read_: ts.Identifier | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'premultipliedAlpha' && node.parent !== parameter) read_ ??= node
    ts.forEachChild(node, visit)
  }
  visit(declaration.body!)
  const spelled = (type: ts.Type | null): readonly string[] | null =>
    type === null ? null : (type.isUnion() ? type.types : [type]).map((part) => checker.typeToString(part)).sort()
  return { parameter: spelled(census.typeAt(parameter)), read: spelled(census.typeAt(read_!)) }
}

test('a stated parameter some closed caller omits holds the statement plus undefined', () => {
  const { parameter, read } = bindingOf('setClear( 0 ); setClear( 1, true );')
  assert.deepEqual(parameter, ['false', 'true', 'undefined'])
  // The body reads the same cell the slot publishes.
  assert.deepEqual(read, ['false', 'true', 'undefined'])
})

test('a stated parameter every caller passes keeps its statement', () => {
  assert.equal(bindingOf('setClear( 0, false ); setClear( 1, true );').parameter, null)
})

test('a statement with an unstated position is left to the JSDoc name census', () => {
  // `Array<*>` reads `any[]`: publishing it would outrank a later resolution of the element.
  assert.equal(bindingOf('setClear( 0 ); setClear( 1, [ 1 ] );', 'Array<*>').parameter, null)
})

test('a passed argument outside the statement refuses', () => {
  assert.equal(bindingOf('setClear( 0 ); setClear( 1, "yes" );').parameter, null)
})

test('an open caller set still holds the omission a visible caller makes', () => {
  // A caller the program cannot see is held to the statement either way; the
  // `undefined` `setClear( 0 )` passes is in the cell whoever else calls it.
  assert.deepEqual(bindingOf('setClear( 0 ); setClear( 1, true ); globalThis.unknownConsumer( setClear );').parameter, [
    'false',
    'true',
    'undefined'
  ])
})

test('a spread that may reach the position refuses', () => {
  assert.equal(bindingOf('setClear( ...[ 0 ] ); setClear( 1, true );').parameter, null)
})
