import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { isUnsharedFreshTableStore } from './fresh-table-last-use.js'

/** The proof's verdict for the right-hand side of the one `slot.defines = <name>` store in `source`. */
const verdict = (source: string): boolean => {
  const fileName = '/fresh-table.ts'
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, noLib: true, types: [] }
  const host = ts.createCompilerHost(options)
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  host.getSourceFile = (name) => (name === fileName ? file : undefined)
  host.fileExists = (name) => name === fileName
  const program = ts.createProgram([fileName], options, host)
  const checker = program.getTypeChecker()
  let value: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'defines'
    )
      value = node.right
    ts.forEachChild(node, visit)
  }
  visit(program.getSourceFile(fileName)!)
  assert.ok(value, 'the program has a `.defines =` store')
  return isUnsharedFreshTableStore(checker, value)
}

// A module, so a top-level table is module-local; `script` is the classic-script form.
const slot = 'export {}\ndeclare const slot: { defines: { [k: string]: any } }\n'
const script = 'declare const slot: { defines: { [k: string]: any } }\n'

test('a fresh local table filled by keyed writes and stored as its last use is unshared', () => {
  assert.equal(
    verdict(
      `${slot}function f(m: number) { const d: { [k: string]: string } = {}; if (m) d.A = ''; d['B'] = d.A ?? ''; slot.defines = d }`
    ),
    true
  )
})

test('a declaration and store inside one loop body declare a fresh table each iteration', () => {
  assert.equal(verdict(`${slot}for (let i = 0; i < 2; i++) { const d: { [k: string]: string } = {}; d.A = ''; slot.defines = d }`), true)
})

test('any reference after the store refuses', () => {
  assert.equal(verdict(`${slot}const d: { [k: string]: string } = {}; slot.defines = d; d.B = ''`), false)
})

test('a store inside a loop the declaration is outside of refuses', () => {
  assert.equal(verdict(`${slot}const d: { [k: string]: string } = {}; for (let i = 0; i < 2; i++) slot.defines = d`), false)
})

test('a closure reference, an alias, a method call or a consumed store refuses', () => {
  assert.equal(verdict(`${slot}const d: { [k: string]: string } = {}; const g = () => d.A; slot.defines = d`), false)
  assert.equal(verdict(`${slot}const d: { [k: string]: string } = {}; const e = d; slot.defines = d`), false)
  assert.equal(verdict(`${slot}const d: any = {}; d.hasOwnProperty('A'); slot.defines = d`), false)
  assert.equal(verdict(`${slot}const d: { [k: string]: string } = {}; let x; x = (slot.defines = d)`), false)
})

test('a non-const or non-literal local refuses', () => {
  assert.equal(verdict(`${slot}let d: { [k: string]: string } = {}; slot.defines = d`), false)
  assert.equal(verdict(`${slot}declare const src: { [k: string]: string }; const d = src; slot.defines = d`), false)
  assert.equal(verdict(`${slot}declare const src: { [k: string]: string }; const d = { ...src }; slot.defines = d`), false)
})

test('a module-scope table another module or script can name refuses', () => {
  const store = "const d: { [k: string]: string } = {}; d.A = ''; slot.defines = d"
  assert.equal(verdict(`${slot}${store}`), true)
  assert.equal(verdict(`${slot}export ${store}`), false)
  assert.equal(
    verdict(`${slot}${store}
export { d }`),
    false
  )
  assert.equal(
    verdict(`${slot}${store}
export { d as table }`),
    false
  )
  assert.equal(
    verdict(`${slot}${store}
export default d`),
    false
  )
  assert.equal(
    verdict(`${slot}${store}
const other = 1
export default other`),
    true
  )
  assert.equal(verdict(`${script}${store}`), false)
  assert.equal(verdict(`${script}function f() { ${store} }`), true)
})

test('a function naming the module-scope table refuses, even one declared before the store', () => {
  assert.equal(verdict(`${slot}const d: { [k: string]: string } = {}; function peek() { return d.A } slot.defines = d`), false)
})
