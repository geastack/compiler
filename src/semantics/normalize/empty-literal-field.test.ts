import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createSubclassMemberOverlayTransform } from '../subclass-member-overlay-transform.js'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { emptyCollectionBindingCensus } from './collection-bindings.js'
import { withFieldBindings } from './field-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * three's `/** @type {Object} *\/ this.userData = {};`: a JS checker reads the
 * `Object` annotation as `any`, and the empty literal's own type `{}` is the
 * vacuous annotation shape, so the field census heard silence from the only
 * write the field ever gets and left every class's `userData` boxed.
 */
const directory = resolve('test/fixtures/empty-literal-field')
const holder = resolve(directory, 'holder.js')

test('an empty object literal written into an any-annotated field binds it', () => {
  const result = createProgram({
    rootFileNames: [holder],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] },
    sourceTransforms: [createSubclassMemberOverlayTransform((file) => readFileSync(file, 'utf8'))]
  })
  // `fileName` is spelled the compiler's way and `directory` the platform's;
  // resolve the one being tested so the prefix is comparable at all.
  const files = result.program.getSourceFiles().filter((file) => resolve(file.fileName).startsWith(directory))
  const checker = result.checker
  const parameters = censusParameterBindings(checker, files, wholeProgram)
  const census = withFieldBindings(
    checker,
    files,
    wholeProgram,
    parameters,
    emptyCollectionBindingCensus,
    indexValueFlow(checker, files, wholeProgram)
  )
  const file = result.program.getSourceFile(holder)!
  let read: ts.PropertyAccessExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.getText() === 'holder.userData') read ??= node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(read)
  const bound = census.typeAt(read)
  const seen = bound === null ? 'unbound' : checker.typeToString(bound)
  assert.notEqual(bound, null, seen)
  assert.equal((bound!.flags & ts.TypeFlags.Any) !== 0, false, seen)
})
