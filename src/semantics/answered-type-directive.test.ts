import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createProgram, defaultCompilerOptions } from './program.js'

const directory = resolve('test/fixtures/answered-type-directive')
const app = resolve(directory, 'app.ts')
const host = resolve(directory, 'host.d.ts')
const installed = resolve(directory, 'node_modules/@types/node/index.d.ts')

const programOf = (typeDirectives?: ReadonlyMap<string, string>) =>
  createProgram({
    rootFileNames: [app, host],
    projectFileName: null,
    options: {
      ...defaultCompilerOptions,
      types: [],
      typeRoots: [resolve(directory, 'node_modules/@types')],
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext
    },
    ...(typeDirectives ? { typeDirectives } : {})
  })

const loaded = (result: ReturnType<typeof createProgram>): readonly string[] =>
  result.program.getSourceFiles().map((file) => resolve(file.fileName))

test("a library's type directive the host answers resolves to the host's file, not the installed @types package", () => {
  const result = programOf(new Map([['node', host]]))
  assert.equal(loaded(result).includes(installed), false)
  assert.deepEqual(
    result.diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')),
    []
  )
})

test('an unanswered type directive still loads the installed @types package past `types: []`', () => {
  const result = programOf()
  assert.equal(loaded(result).includes(installed), true)
})
