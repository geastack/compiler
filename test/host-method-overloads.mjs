import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { resolveHostMethod } from '../dist/semantics/host-methods.js'

const require = createRequire(import.meta.url)
const file = resolve('dist/host-method-overloads.ts')
const augmentation = resolve('dist/host-method-augmentation.ts')
const source = `
interface NativeText { toString(encoding: 'hex'): string }
type View = Uint8Array & NativeText
declare const native: View
native.toString('hex')
declare const plain: Uint8Array
plain.toString()
interface CallerExtra { toString(value: { extra: true }): string }
declare const extended: View & CallerExtra
extended.toString({extra: true})
class Concrete { toString(): string { return 'caller' } }
declare const concrete: NativeText & Concrete
concrete.toString()
`
const inspect = (coverage, augment = false) => {
  const options = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    resolve(name) === resolve(file)
      ? ts.createSourceFile(name, source, version, true)
      : name === augmentation
        ? ts.createSourceFile(
            name,
            'interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> { toString(extra: boolean): string }',
            version,
            true
          )
        : getSourceFile(name, version, onError, fresh)
  const program = ts.createProgram(augment ? [file, augmentation] : [file], options, host)
  const bindings = new Map([
    [
      file,
      new Map([
        [
          'NativeText.toString',
          {
            protocol: 'test:NativeText',
            member: 'toString',
            ...(coverage
              ? {
                  inheritedDeclarations: [
                    { declarationFileName: require.resolve('typescript/lib/lib.es5.d.ts'), owner: 'Uint8Array', member: 'toString' }
                  ]
                }
              : {})
          }
        ]
      ])
    ]
  ])
  const result = new Map()
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node))
      result.set(node.expression.getText(), resolveHostMethod(program.getTypeChecker(), bindings, node))
    ts.forEachChild(node, visit)
  }
  visit(program.getSourceFile(file))
  return result
}

test('inherited overload coverage requires an authenticated primary declaration', () => {
  assert.equal(inspect(false).get('native'), null)
  const results = inspect(true)
  assert.equal(results.get('native')?.protocol, 'test:NativeText')
  assert.equal(results.get('plain'), null)
  assert.equal(results.get('extended'), null)
  assert.equal(results.get('concrete'), null)
})
test('a caller augmentation is not an inherited host declaration', () => {
  assert.equal(inspect(true, true).get('native'), null)
})
