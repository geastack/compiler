import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { functionIntersectionMemberTypeOf } from './derived-expression-type.js'

// A byte-utility module's feature probe: `typeof Buffer === 'function'` narrows to `X & Function`,
// whose `prototype` is `Function.prototype`'s `any`.
const entry = resolve('test/runtime/optional-chain-on-function-narrowed-prototype-field.runtime.ts')
const source = `
declare const Buffer: { new (): unknown; prototype?: { _isBuffer?: boolean } } | undefined
declare const plain: (() => void) | undefined
export const narrowed = typeof Buffer === 'function' && Buffer.prototype?._isBuffer !== true
export const unstated = typeof plain === 'function' && plain.prototype
`
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, noEmit: true }
const host = ts.createCompilerHost(options, true)
const original = host.getSourceFile.bind(host)
host.getSourceFile = (name, version, onError, fresh) =>
  resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, onError, fresh)
const program = ts.createProgram({ rootNames: [entry], options, host })
const checker = program.getTypeChecker()
const file = program.getSourceFile(entry)!
const accesses: ts.PropertyAccessExpression[] = []
const visit = (node: ts.Node): void => {
  if (ts.isPropertyAccessExpression(node)) accesses.push(node)
  ts.forEachChild(node, visit)
}
visit(file)
const access = (text: string): ts.PropertyAccessExpression => {
  const found = accesses.find((node) => node.getText() === text)
  assert.ok(found, text)
  return found
}
const typeText = (node: ts.Node): string | null => {
  const type = functionIntersectionMemberTypeOf(checker, node)
  return type === null ? null : checker.typeToString(type)
}

test('the checker types both links of the narrowed chain any', () => {
  assert.equal(checker.typeToString(checker.getTypeAtLocation(access('Buffer.prototype'))), 'any')
  assert.equal(checker.typeToString(checker.getTypeAtLocation(access('Buffer.prototype?._isBuffer'))), 'any')
})

test('each link reads the member the narrowed type declared', () => {
  assert.equal(typeText(access('Buffer.prototype')), '{ _isBuffer?: boolean | undefined; } | undefined')
  assert.equal(typeText(access('Buffer.prototype?._isBuffer')), 'boolean | undefined')
})

test('a callable that states no prototype keeps the checker answer', () => {
  assert.equal(typeText(access('plain.prototype')), null)
})
