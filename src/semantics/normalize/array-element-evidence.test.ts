import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusCollectionBindings, emptyCollectionBindingCensus } from './collection-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusReachability } from './reachability.js'

/**
 * `collectArrayLiterals`/`collectConstructions` (`collection-bindings.ts`)
 * used to walk every class member's body unconditionally, with no
 * `reachable.memberIsPruned` guard -- unlike `flow/value-flow.ts`'s own
 * `visit`, which has carried that exact guard since normalization started
 * excluding dead members from write evidence ("excluded bodies cannot
 * contribute callers or writes to the live program's typing evidence").
 *
 * The mismatch turned a class method reachability correctly marks dead into a
 * GUARANTEED `array:no-writes` refusal for every empty-array literal inside
 * it: this module still collected the literal as a live candidate needing
 * evidence, while `flow` -- the one place this module reads evidence from --
 * had already, correctly, recorded zero writes for a body that never runs.
 *
 * MEASURED on the three.js app: this was 44 of the 45
 * `array:no-writes` refusals and 8 of the 9 `array:element-unresolved`
 * refusals feeding the `array-element` boxed-carrier position -- all four of
 * `AnimationClip`'s `parse`/`toJSON`/`CreateFromMorphTargetSequence`/`clone`
 * among them, plus `Object3D`'s `toJSON`, `Skeleton`'s `clone`,
 * `PMREMGenerator`'s internal helpers and the TSL `Node`/`ContextNode`/
 * `LightsNode`/`NodeMaterial` base classes' unused branches.
 */

const programFor = (fileName: string): { readonly checker: ts.TypeChecker; readonly file: ts.SourceFile } => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true, strict: true }
  const program = ts.createProgram([fileName], options)
  return { checker: program.getTypeChecker(), file: program.getSourceFile(fileName)! }
}

/** The one empty array literal in a fixture, by the identifier name it is declared with. */
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
    ) {
      found = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `no empty array literal named \`${name}\` in ${file.fileName}`)
  return found!
}

test('a pruned member is no longer censused as an array:no-writes failure', () => {
  const fileName = resolve('test/fixtures/array-element-evidence-pruned.js')
  const { checker, file } = programFor(fileName)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })

  const clip = file.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'Clip') as
    ts.ClassDeclaration | undefined
  const parseMethod = clip?.members.find((member) => member.name?.getText() === 'parse')
  assert.ok(parseMethod)
  // Sanity: `Clip.parse` really is the dead code this fix is about -- nothing
  // in the fixture ever calls it.
  assert.equal(reachable.memberIsPruned(parseMethod!), true)

  const flow = indexValueFlow(checker, [file], reachable)
  const tracks = findEmptyArrayLiteral(file, 'tracks')
  const census = censusCollectionBindings(checker, [file], reachable, undefined, flow)

  assert.equal(census.arrayElementAt(tracks), null)
  assert.equal(
    census.arrayRefusalOf(tracks),
    null,
    'a literal inside a pruned member must not be a candidate at all, so it must carry no refusal either'
  )
  assert.ok(
    !census.refusals.some((refusal) => refusal.owner.startsWith('tracks (') && refusal.key === 'census:collection:array-no-writes'),
    'a literal inside a pruned member must not be reported as an array:no-writes failure'
  )
})

test('the identical shape in LIVE code still binds the array element type', () => {
  const fileName = resolve('test/fixtures/array-element-evidence-live.js')
  const { checker, file } = programFor(fileName)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })

  const clip = file.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'Clip') as
    ts.ClassDeclaration | undefined
  const parseMethod = clip?.members.find((member) => member.name?.getText() === 'parse')
  assert.ok(parseMethod)
  assert.equal(reachable.memberIsPruned(parseMethod!), false)

  const flow = indexValueFlow(checker, [file], reachable)
  const tracks = findEmptyArrayLiteral(file, 'tracks')
  const census = censusCollectionBindings(checker, [file], reachable, undefined, flow)

  assert.equal(census.arrayRefusalOf(tracks), null)
  const bound = census.arrayElementAt(tracks)
  assert.ok(bound, 'a live `.push` loop of well-typed elements must bind an element type')
  assert.equal(checker.typeToString(bound!), 'Track')
})

test('a genuinely unwritten array in LIVE code still refuses array:no-writes', () => {
  const fileName = resolve('test/fixtures/array-element-evidence-unwritten.js')
  const { checker, file } = programFor(fileName)
  const reachable = censusReachability({ checker, files: [file], entries: [file] })

  const empty = file.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'Empty') as
    ts.ClassDeclaration | undefined
  const buildMethod = empty?.members.find((member) => member.name?.getText() === 'build')
  assert.ok(buildMethod)
  // Sanity: `build` is live (it IS called), so this is not the pruned-member
  // case above -- the refusal below must come from having no evidence at all.
  assert.equal(reachable.memberIsPruned(buildMethod!), false)

  const flow = indexValueFlow(checker, [file], reachable)
  const tracks = findEmptyArrayLiteral(file, 'tracks')
  const census = censusCollectionBindings(checker, [file], reachable, undefined, flow)

  assert.equal(census.arrayElementAt(tracks), null)
  assert.equal(census.arrayRefusalOf(tracks), 'array:no-writes')
  assert.ok(
    census.refusals.some((refusal) => refusal.owner.startsWith('tracks (') && refusal.key === 'census:collection:array-no-writes'),
    'a live cell with no writes anywhere must still refuse array:no-writes'
  )
})

test('emptyCollectionBindingCensus is unaffected (no program, nothing to bind)', () => {
  assert.equal(emptyCollectionBindingCensus.boundCount, 0)
})
