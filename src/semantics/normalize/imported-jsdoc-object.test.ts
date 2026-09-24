import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from '../program.js'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * three's `constants.js` declares `/** @type {Object} *\/ export const
 * Compatibility = { TEXTURE_COMPARE: 'depthTextureCompare' }`, and
 * `WebGPUBackend.js` imports it to build `{ [ Compatibility.TEXTURE_COMPARE ]:
 * ... }`. Under `strict` the tag is the global `Object` interface, which has no
 * `TEXTURE_COMPARE`, so the checker types the key `any` and the literal refused
 * as a computed key with no ToPropertyKey conversion. The binding census types
 * the const from its writes in `constants.js`; a read through the import binding
 * has to reach that same declaration.
 */
const directory = resolve('test/fixtures/imported-jsdoc-object')
const backend = resolve(directory, 'backend.js')

const keyTypes = (): ReadonlyMap<string, string> => {
  const result = createProgram({
    rootFileNames: [backend],
    projectFileName: null,
    options: { ...defaultCompilerOptions, checkJs: false, types: [] }
  })
  const files = result.program.getSourceFiles().filter((file) => resolve(file.fileName).startsWith(directory))
  const checker = result.checker
  const census = censusParameterBindings(checker, files, wholeProgram)
  const types = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const property = node.initializer.properties[0]
      if (property?.name && ts.isComputedPropertyName(property.name)) {
        const key = property.name.expression
        const bound = census.typeAt(key)
        types.set(node.name.text, bound === null ? 'unbound' : checker.typeToString(bound))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(result.program.getSourceFile(backend)!)
  return types
}

test('a member read through an imported JSDoc {Object} const takes the type its declaring module gives it', () => {
  const types = keyTypes()
  assert.equal(types.get('imported'), 'string')
  assert.equal(types.get('renamed'), 'string')
})

test('an imported JSDoc {Object} const whose initializer states nothing still types nothing', () => {
  assert.notEqual(keyTypes().get('opaque'), 'string')
})
