import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { unconstructedThisInsertions, withInsertions } from './unconstructed-this.js'

const programOf = (files: ReadonlyMap<string, string>): ts.Program => {
  const options: ts.CompilerOptions = { allowJs: true, checkJs: false, noEmit: true, types: [], module: ts.ModuleKind.CommonJS }
  const host = ts.createCompilerHost(options, true)
  const read = host.getSourceFile.bind(host)
  const exists = host.fileExists.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = files.get(name)
    return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.fileExists = (name) => files.has(name) || exists(name)
  return ts.createProgram([...files.keys()], options, host)
}

const server = [
  'function listen (port) {',
  '  const onAborted = () => { this.aborted = true }',
  '  return onAborted()',
  '}',
  'function Boot () { this.name = 1 }',
  'const Router = function () { this.routes = [] }',
  'function reads () { return this.x }',
  '/** @param {number} x */',
  'function documented (x) { this.x = x }',
  '/** @this {Window} */ function stated () { this.x = 1 }',
  'function Base () { this.base = true }',
  'module.exports = { listen, Boot, Router, reads, stated, Base }',
  ''
].join('\n')
const user = "const { Boot, Router, Base } = require('./server.js')\nnew Boot()\nnew Router()\nclass Child extends Base {}\n"

test('only a this-assigning function no new expression or extends clause names states a caller-supplied this', () => {
  const insertions = unconstructedThisInsertions(
    programOf(
      new Map([
        ['/server.js', server],
        ['/user.js', user]
      ])
    )
  )
  assert.deepEqual([...insertions.keys()], ['/server.js'])
  const prepared = withInsertions(server, insertions.get('/server.js')!)
  assert.ok(prepared.startsWith('/** @this {any} */ function listen (port) {'))
  assert.equal(prepared.split('@this {any}').length - 1, 2)
  assert.ok(prepared.includes('/** @param {number} x  @this {any} */\nfunction documented (x)'))
})

test('a TypeScript file is never prepared', () => {
  assert.equal(unconstructedThisInsertions(programOf(new Map([['/a.ts', 'export function f(this: any) { this.x = 1 }\n']]))).size, 0)
})
