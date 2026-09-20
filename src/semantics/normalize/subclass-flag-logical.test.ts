import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createSubclassMemberOverlayTransform } from '../subclass-member-overlay-transform.js'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * three's `materialProperties.needsLights = materialNeedsLights( material )`:
 * a `MeshBasicMaterial` declares none of the flags the chain reads, so the
 * call returns `undefined`. Typing it `boolean` laid the field out as a bare
 * `bool`, and the first frame threw storing `undefined` into it.
 */
const directory = resolve('test/fixtures/subclass-flag-logical')
const renderer = resolve(directory, 'renderer.js')

const censusOf = () => {
  const result = createProgram({
    rootFileNames: [renderer],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] },
    sourceTransforms: [createSubclassMemberOverlayTransform((file) => readFileSync(file, 'utf8'))]
  })
  // `fileName` is spelled the compiler's way and `directory` the platform's;
  // resolve the one being tested so the prefix is comparable at all.
  const files = result.program.getSourceFiles().filter((file) => resolve(file.fileName).startsWith(directory))
  const census = censusParameterBindings(result.checker, files, wholeProgram)
  const file = result.program.getSourceFile(renderer)!
  const find = <T extends ts.Node>(guard: (node: ts.Node) => node is T, text: string): T => {
    let found: T | undefined
    const visit = (node: ts.Node): void => {
      if (guard(node) && node.getText() === text) found ??= node
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.ok(found, text)
    return found
  }
  const typeOf = (node: ts.Node): string | null => {
    const type = census.typeAt(node)
    return type === null ? null : result.checker.typeToString(type)
  }
  const refusalOf = (parameter: ts.ParameterDeclaration): string | null => census.refusalOf(parameter)
  return { find, typeOf, refusalOf }
}

test('a subclass-only flag read on the base keeps the absence a lacking subclass reads', () => {
  const { find, typeOf, refusalOf } = censusOf()
  const parameter = find(ts.isParameter, 'material')
  const read = find(ts.isPropertyAccessExpression, 'material.isShaderMaterial')
  const call = find(ts.isCallExpression, 'materialNeedsLights(material)')
  const seen = `parameter ${typeOf(parameter)} (refusal ${refusalOf(parameter)}), read ${typeOf(read)}, call ${typeOf(call)}`
  assert.equal(typeOf(parameter), 'Material', seen)
  assert.ok(typeOf(call)?.includes('undefined'), seen)
})
