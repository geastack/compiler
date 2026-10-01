import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * three's `ColorBuffer.setClear`, reduced: the declaration overlay states
 * `@param {boolean} premultipliedAlpha`, and `colorBuffer.setClear( 0, 0, 0,
 * 1 )` leaves it out.
 */
const bindingOf = (calls: string, statement = 'boolean', tagged = 'premultipliedAlpha', dynamicFallback = false) => {
  const entry = resolve('test/fixtures/omitted-stated-parameter.js')
  const source = `export {};
    /**
     * @param {number} r
     * @param {${statement}} ${tagged}
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
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, undefined, undefined, dynamicFallback)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index)
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

test('a passed argument outside the statement joins the cell', () => {
  assert.deepEqual(bindingOf('setClear( 0 ); setClear( 1, "yes" );').parameter, ['false', 'string', 'true', 'undefined'])
  // With no caller omitting it: pino's `@param {string}` called with a Number.
  const { parameter, read } = bindingOf('setClear( 0, 1 ); setClear( 1, true );')
  assert.deepEqual(parameter, ['false', 'number', 'true'])
  assert.deepEqual(read, ['false', 'number', 'true'])
  // Beside an argument nothing types, the disproven statement states nothing.
  assert.deepEqual(bindingOf('setClear( 0, 1 ); setClear( 1, JSON.parse( "true" ) );').parameter, ['any'])
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

test('an optional stated parameter a caller passes something else holds that too', () => {
  // fastify's `reqIdGenFactory`: `@param {string} [requestIdHeader]`, handed
  // `false` when no header is configured.
  const { parameter } = bindingOf("setClear( 0, false ); setClear( 1, 'x' );", 'string', '[premultipliedAlpha]')
  assert.deepEqual(parameter, ['false', 'string', 'true', 'undefined'])
})

test('an untyped argument with a typed branch outside the statement leaves the cell any', () => {
  // fastify's `requestIdHeader`: `any` as a whole, and `false | "request-id"` on
  // the branch that answers when no header is configured.
  const calls =
    "const header = /** @type {any} */ ( globalThis ).header; const h = typeof header === 'string' ? /** @type {any} */ ( header ).toLowerCase() : ( header === true && 'request-id' ); setClear( 0, h );"
  assert.deepEqual(bindingOf(calls, 'string', '[premultipliedAlpha]').parameter, ['any'])
  assert.equal(bindingOf('setClear( 0, /** @type {any} */ ( globalThis ).header );', 'string', '[premultipliedAlpha]').parameter, null)
})

test('under the fallback, a plain object statement every caller hands an untyped value holds that value', () => {
  // fastify's `router.setup(options)`: `@param {FastifyServerOptions}`, handed
  // the `any` copy `processOptions` has written a logger instance into.
  const untyped = 'setClear( 0, /** @type {any} */ ( globalThis ).options );'
  const statement = '{ logger?: boolean | { level?: string } }'
  assert.deepEqual(bindingOf(untyped, statement, 'premultipliedAlpha', true).parameter, ['any'])
  assert.equal(bindingOf(untyped, statement).parameter, null)
  // A typed caller, a primitive statement, and a class statement keep theirs.
  assert.equal(bindingOf(`${untyped} setClear( 1, { logger: true } );`, statement, 'premultipliedAlpha', true).parameter, null)
  assert.equal(bindingOf(untyped, 'boolean', 'premultipliedAlpha', true).parameter, null)
  assert.equal(bindingOf(`class Held {} ${untyped}`, 'Held', 'premultipliedAlpha', true).parameter, null)
})
