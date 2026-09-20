import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { createReassignedBindingCensus } from './reassigned-bindings.js'

const audit = (source: string) => {
  const entry = resolve('test/runtime/native-array-reflection-transport.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, noEmit: true }
  const host = ts.createCompilerHost(options, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, onError, fresh)
  const program = ts.createProgram({ rootNames: [entry], options, host })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const census = createReassignedBindingCensus(checker, flow)
  const symbols = new Map<string, ts.Symbol>()
  const walk = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const symbol = checker.getSymbolAtLocation(node.name)
      if (symbol) symbols.set(node.name.text, symbol)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return (name: string): boolean => {
    const symbol = symbols.get(name)
    assert.ok(symbol, name)
    assert.equal(census.isReassignedAnywhere(symbol), census.isReassignedIn(file, symbol))
    return census.isReassignedAnywhere(symbol)
  }
}

test('literal values, constructor calls, computed keys and defaults do not reassign their functions', () => {
  const changed = audit(`
    class Point { constructor() {} }
    function make() { return 1 }
    function key() { return 'x' }
    const values = [new Point(), make(), { make, [key()]: Point }]
    let target; ({ [key()]: target = make() } = {})
  `)
  for (const name of ['Point', 'make', 'key']) assert.equal(changed(name), false, name)
})

test('real nested, shorthand, rest, defaulted and iteration assignment targets remain mutable', () => {
  for (const assignment of [
    'f = replacement',
    'f ||= replacement',
    '[f] = values',
    '({f} = values)',
    '({x: [f = replacement]} = values)',
    '[...f] = values',
    'for ([f] of values) {}',
    'for ({x: f} of values) {}'
  ]) {
    const changed = audit(`function f() {} function replacement() {} let values; ${assignment};`)
    assert.equal(changed('f'), true, assignment)
    assert.equal(changed('replacement'), false, assignment)
  }
})

test('namespace property and destructuring writes invalidate the exported function', () => {
  for (const assignment of ['Space.f = replacement', "Space['f'] = replacement", '({x: Space.f} = values)']) {
    const changed = audit(`namespace Space { export function f() {} } function replacement() {} let values; ${assignment};`)
    assert.equal(changed('f'), true, assignment)
    assert.equal(changed('replacement'), false, assignment)
  }
})
