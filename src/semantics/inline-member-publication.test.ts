import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexAliasEvidence, indexNamedCallables } from './normalize/derived-expression-type.js'
import { wholeProgram } from './normalize/reachability.js'

test('member publication records inline callbacks by member identity without conflating unrelated names', () => {
  const path = resolve('test/runtime/projected-inline-method-publications.js')
  const source = ts.createSourceFile(
    path,
    `
    class Base { hook() {} }
    class Other { hook() {} }
    const first = new Base(), second = new Other();
    first.hook = function(value) { return value };
    first.hook = value => value;
    second.hook = function(value) { return value };
  `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, ...rest) => (resolve(file) === resolve(path) ? source : original(file, language, ...rest))
  const program = ts.createProgram([path], options, host)
  const checker = program.getTypeChecker()
  const evidence = indexAliasEvidence(checker, [source], wholeProgram, indexNamedCallables(checker, [source], wholeProgram))
  const assignments: ts.BinaryExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left))
      assignments.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(assignments.length, 3)
  const members = assignments.map((assignment) => checker.getSymbolAtLocation((assignment.left as ts.PropertyAccessExpression).name)!)
  assert.ok(members.every(Boolean))
  assert.equal(members[0], members[1])
  assert.notEqual(members[0], members[2])
  assert.deepEqual([...evidence.publishedUnderMember.get(members[0]!)!], [assignments[0]!.right, assignments[1]!.right])
  assert.deepEqual([...evidence.publishedUnderMember.get(members[2]!)!], [assignments[2]!.right])
})
