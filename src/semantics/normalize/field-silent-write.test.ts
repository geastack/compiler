import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { emptyCollectionBindingCensus } from './collection-bindings.js'
import { censusFieldBindings } from './field-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * `field-bindings.ts:828`'s `write-unresolved`: a class field whose one
 * whole-value write is a vacuous empty array literal (`never[]` to the
 * checker, correctly unusable as evidence) reads as SILENCE, not as a
 * disagreement -- and three's `WebGLRenderer.clippingPlanes` /
 * `UniformsGroup.uniforms` carry a JSDoc `@type` tag directly above that one
 * write naming a concrete element (`Array<Plane>`, `Array<Uniform>`).
 * `isCandidateSymbol`'s own doc already says an annotated field means "the
 * program DID state something ... this module defers" -- true for a
 * `PropertyDeclaration`, never checked for the OTHER declaration shape this
 * module types (a bare `this.x = expr` assignment), so a fully-described
 * field was admitted as an unannotated candidate anyway and could only ever
 * refuse: `compute`'s `PropertyAccessExpression` case returns whatever
 * `resolveSymbol` answers the instant a symbol is a candidate, never falling
 * through to the ordinary checker-backed `propertyTypeOf`/`memberTypeOf`
 * lookup that already reads the JSDoc-informed member type correctly.
 * `assignmentStatesCompleteJsDocType` closes that gap by excluding such a
 * symbol from candidacy the same way a fully-annotated `PropertyDeclaration`
 * already is.
 */
const directory = resolve('test/fixtures/field-silent-write')
const holder = resolve(directory, 'holder.js')

const audit = () => {
  const result = createProgram({
    rootFileNames: [holder],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] }
  })
  // `fileName` is spelled the compiler's way and `directory` the platform's;
  // resolve the one being tested so the prefix is comparable at all.
  const files = result.program.getSourceFiles().filter((file) => resolve(file.fileName).startsWith(directory))
  const checker = result.checker
  const flow = indexValueFlow(checker, files, wholeProgram)
  const parameters = censusParameterBindings(checker, files, wholeProgram)
  const fields = censusFieldBindings(checker, files, wholeProgram, parameters, emptyCollectionBindingCensus, flow)
  const file = result.program.getSourceFile(holder)!
  const readOf = (text: string): ts.PropertyAccessExpression => {
    let read: ts.PropertyAccessExpression | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.getText() === text) read ??= node
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(read, `no read of ${text} found`)
    return read
  }
  return { checker, fields, readOf }
}

test('a fully-described JSDoc-annotated array field defers to the checker instead of refusing', () => {
  const { checker, fields, readOf } = audit()
  const read = readOf('holder.clippingPlanes')
  const bound = fields.typeAt(read)
  const seen = bound === null ? 'unbound' : checker.typeToString(bound)
  assert.notEqual(bound, null, seen)
  assert.equal(seen, 'Plane[]')
  // Not a candidate at all -- `Holder.clippingPlanes` must not appear as a
  // refusal, the same way an annotated `PropertyDeclaration` never does.
  assert.ok(!fields.refusals.some((refusal) => refusal.owner.startsWith('clippingPlanes')))
})

test('NEGATIVE CONTROL: an Array<Object>-annotated field still refuses a genuinely silent write', () => {
  const { fields, readOf } = audit()
  const read = readOf('vacuous.entries')
  assert.equal(fields.typeAt(read), null)
  const refusal = fields.refusals.find((entry) => entry.owner.startsWith('entries'))
  assert.ok(refusal, 'expected `entries` to be a refused candidate, not silently excluded')
  assert.equal(refusal!.reason, 'write-unresolved')
})
