import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

const infer = (extra = '') => {
  const entry = resolve('test/fixtures/late-local-member.js')
  const source = `export {};
    class Layers { enabled = 0; enableAll() { this.enabled = 1; } }
    class Base { constructor() { this.layers = new Layers(); } hook() {} }
    class Mesh extends Base {}
    /** @param {Mesh} instance */
    function invoke(instance) { instance.hook({amount:3}); }
    function run() {
      let held;
      function render() {
        if (held === undefined) {
          const mesh = new Mesh();
          held = mesh;
          mesh.hook = function(input) { return input.amount; };
          invoke(mesh);
        }
        held.layers.enableAll();
        ${extra}
      }
      render();
    }
    run();`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const index = indexParameterBindingProgram(checker, [file], wholeProgram)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index)
  let callback: ts.FunctionExpression | undefined
  let lateRead: ts.PropertyAccessExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node)) callback = node
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'held' && node.name.text === 'layers') lateRead = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(callback && lateRead)
  return { checker, type: census.typeAt(callback.parameters[0]!), location: callback, lateRead, debug: census.debugReport?.() }
}

test('late local aliases retain native owner fields during callback inference', () => {
  const result = infer()
  assert.equal(result.checker.getTypeAtLocation(result.lateRead.expression).flags & ts.TypeFlags.Any, ts.TypeFlags.Any)
  const amount = result.type && result.checker.getPropertyOfType(result.type, 'amount')
  assert.ok(amount, result.debug)
  assert.ok((result.checker.getTypeOfSymbolAtLocation(amount, result.location).flags & ts.TypeFlags.NumberLike) !== 0)
})

test('a late alias passed to unknown code cannot close its native owner callback', () => {
  const result = infer('globalThis.unknownConsumer(held);')
  assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
})
