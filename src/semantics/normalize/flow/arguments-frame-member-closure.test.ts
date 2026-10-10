import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings } from '../parameter-bindings.js'
import { wholeProgram } from '../reachability.js'

/**
 * A tree node's `add( object )` that also walks its own `arguments` to add
 * several children at once. A member proof that follows a node into
 * `scene.add( sun )` must follow it into that frame too, not give up on the
 * whole family: every `beforeDraw` callback's `renderer` hangs on that one
 * refusal.
 */
const censusOf = (tail: string) => {
  const entry = resolve('test/fixtures/arguments-frame-member-closure.js')
  const source = `export {};
    class TreeNode {
      constructor() { this.parent = null; }
      /** @param {TreeNode} object */
      add( object ) {
        if ( arguments.length > 1 ) {
          for ( let i = 0; i < arguments.length; i ++ ) this.add( arguments[ i ] );
          return this;
        }
        object.parent = this;
        return this;
      }
      beforeDraw() {}
    }
    class Renderer {
      /** @param {TreeNode} object */
      render( object ) { object.beforeDraw( this, object ); }
    }
    const scene = new TreeNode();
    const mesh = new TreeNode();
    mesh.beforeDraw = function ( renderer, object ) { this.parent = object.parent; };
    scene.add( mesh );
    new Renderer().render( mesh );
    ${tail}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const census = censusParameterBindings(checker, [file], wholeProgram)
  let callback: ts.FunctionExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionExpression(node) &&
      ts.isBinaryExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.left) &&
      node.parent.left.name.text === 'beforeDraw'
    )
      callback = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  const renderer = callback!.parameters[0]!
  const bound = census.typeAt(renderer)
  return { spelled: bound === null ? null : checker.typeToString(bound), report: () => census.debugReport?.() ?? '' }
}

test('an argument that also lands in the frame a variadic add walks stays closed', () => {
  const { spelled, report } = censusOf('')
  assert.equal(spelled, 'Renderer', report())
})

test('a frame that goes anywhere else keeps the member open', () => {
  for (const leak of [
    'TreeNode.prototype.leak = function () { globalThis.unknownConsumer( arguments ); }; mesh.leak( scene );',
    'TreeNode.prototype.keep = function () { globalThis.kept = arguments[ 0 ]; }; mesh.keep( scene );'
  ])
    assert.equal(censusOf(leak).spelled, null, leak)
})
