import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusCollectionBindings } from './collection-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusReachability } from './reachability.js'

/**
 * On 2026-09-14 the three.js app reported `array-element-unresolved` for
 * `uploadCubeTexture`'s `cubeImage` with the ternary write
 * `isDataTexture ? textureImages[ i ].image : textureImages[ i ]` named as
 * the offending element, which read as "the array census cannot type a
 * conditional". It can: `derivedExpressionType` joins a ternary's two arms
 * as a two-element write set, exactly as it does for a cell. The `any` came
 * from the plugin's `requireTextureImageRecords` typing a cube face as
 * `{ data?, width?, height?, depth? }`, a record with NO `image` member, so
 * the checker's answer for `textureImages[ i ].image` was the error type and
 * the whole conditional inherited it. This test pins the compiler's side of
 * that finding: the same three writes, with every arm well typed, bind one
 * element type and refuse nothing -- so a future `array-element-unresolved`
 * naming a ternary is a typing hole in the PROGRAM, not in this census.
 */

const programFor = (fileName: string): { readonly checker: ts.TypeChecker; readonly file: ts.SourceFile } => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true, strict: true }
  const program = ts.createProgram([fileName], options)
  return { checker: program.getTypeChecker(), file: program.getSourceFile(fileName)! }
}

const findEmptyArrayLiteral = (file: ts.SourceFile, name: string): ts.ArrayLiteralExpression => {
  let found: ts.ArrayLiteralExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer) &&
      node.initializer.elements.length === 0
    )
      found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `no empty array literal named \`${name}\` in ${file.fileName}`)
  return found!
}

test('an index-assigned ternary whose arms are two record shapes binds the array element', () => {
  const fileName = resolve('test/fixtures/array-element-ternary-record-arms.js')
  const { checker, file } = programFor(fileName)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })
  const flow = indexValueFlow(checker, [file], reachable)
  const cubeImage = findEmptyArrayLiteral(file, 'cubeImage')
  const census = censusCollectionBindings(checker, [file], reachable, undefined, flow)

  const refusal = census.refusals.find((entry) => entry.owner.startsWith('cubeImage ('))
  assert.equal(refusal, undefined, refusal && `${refusal.key}: ${refusal.reason}`)
  assert.equal(census.arrayRefusalOf(cubeImage), null)
  const bound = census.arrayElementAt(cubeImage)
  assert.ok(bound, 'three well-typed writes, one of them a ternary of two record arms, must bind an element type')
  // The nested image record covers the face (every face-only member is
  // optional), so the join keeps the covering shape and the nullish arm --
  // which is also why the plugin routes the data-texture arm through
  // `requireTextureImageRecord`: a program that needs the face-only members
  // (`mipmaps`) must make both arms the SAME record, the census will not
  // invent a wider one.
  assert.equal(checker.typeToString(bound!), 'ImageRecord | undefined')
})
