import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { undefinedDefaultParameterTransform as transform } from './undefined-default-parameter-transform.js'

const listen = `function createServer () {
  function listen (
    listenOptions = { port: 0, host: 'localhost' },
    cb = undefined
  ) {
    return cb
  }
  return listen
}
module.exports = { createServer }
`

test('an undefined default states the parameter untyped, keeping the function text and its length', () => {
  const actual = transform({ fileName: 'server.js', text: listen })
  assert.ok(actual !== null)
  assert.match(actual, /\/\*\*\n {3}\* @param \{any\} \[cb\]\n {3}\*\/\n {2}function listen \(/)
  assert.ok(actual.includes(listen.slice(listen.indexOf('function listen'), listen.indexOf('return listen'))))
})

test('a TypeScript importer may pass a callback once the default no longer types the parameter', () => {
  const check = (library: string): readonly string[] => {
    const files = new Map([
      ['/lib.js', library],
      ['/main.ts', "import { createServer } from './lib.js'\ncreateServer()({ port: 3, host: 'h' }, (err: any, address: any) => {})\n"]
    ])
    const options: ts.CompilerOptions = {
      allowJs: true,
      strict: true,
      noEmit: true,
      types: [],
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
    const host = ts.createCompilerHost(options, true)
    const read = host.getSourceFile.bind(host)
    const exists = host.fileExists.bind(host)
    host.getSourceFile = (name, version, ...rest) => {
      const text = files.get(name)
      return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
    }
    host.fileExists = (name) => files.has(name) || exists(name)
    const program = ts.createProgram(['/main.ts', '/lib.js'], options, host)
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  }
  assert.ok(check(listen).some((message) => message.includes("parameter of type 'undefined'")))
  assert.deepEqual(check(transform({ fileName: '/lib.js', text: listen })!), [])
})

test('the tag goes where the checker reads it for a function expression', () => {
  assert.match(
    transform({ fileName: 'a.js', text: 'const f = function (a, b = undefined) {}' })!,
    /^\/\*\*\n \* @param \{any\} \[b\]\n \*\/\nconst f/
  )
  assert.match(transform({ fileName: 'a.js', text: 'o.m = (b = undefined) => b' })!, /^\/\*\*\n \* @param \{any\} \[b\]\n \*\/\no\.m/)
  assert.equal(
    transform({ fileName: 'a.js', text: 'x({ m: function (b = undefined) {} })' }),
    'x({ /**\n  * @param {any} [b]\n  */\n m: function (b = undefined) {} })'
  )
})

test('an existing JSDoc block takes the tag, so its own parameter types stay attached', () => {
  assert.equal(
    transform({ fileName: 'a.js', text: '/** @param {string} a */\nfunction f (a, b = undefined) {}' }),
    '/** @param {string} a  @param {any} [b] */\nfunction f (a, b = undefined) {}'
  )
})

test('what the source already states, and anything but the global undefined, is left as written', () => {
  for (const text of [
    '/** @param {Function} [cb] */ function f (cb = undefined) {}',
    'function f (/** @type {Function} */ cb = undefined) {}',
    '/** @type {(cb?: Function) => void} */ const f = function (cb = undefined) {}',
    'function f (cb = void 0) {}',
    'function f (cb = null) {}',
    'function f (...cb) {}',
    'function f ({ cb } = undefined) {}',
    'const f = (cb = undefined) => cb, g = 1',
    'var undefined = 1; function f (cb = undefined) {}'
  ])
    assert.equal(transform({ fileName: 'a.js', text }), null, text)
  assert.equal(transform({ fileName: 'a.ts', text: 'function f (cb = undefined) {}' }), null)
})
