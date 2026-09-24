import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { elidedTypeImportSpecifiers } from './elided-type-imports.js'

const programOf = (files: ReadonlyMap<string, string>, options: ts.CompilerOptions = {}): ts.Program => {
  const settings: ts.CompilerOptions = { strict: true, noEmit: true, types: [], module: ts.ModuleKind.CommonJS, allowJs: true, ...options }
  const host = ts.createCompilerHost(settings, true)
  const read = host.getSourceFile.bind(host)
  const exists = host.fileExists.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = files.get(name)
    return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.fileExists = (name) => files.has(name) || exists(name)
  return ts.createProgram(
    [...files.keys()].filter((name) => !name.endsWith('.d.ts')),
    settings,
    host
  )
}

const library = 'export interface Shape { size: number }\nexport const make = (): Shape => ({ size: 1 })\n'

test('a value-syntax import named only in type positions is elided, by the alias symbol', () => {
  const found = elidedTypeImportSpecifiers(
    programOf(
      new Map([
        ['/lib.ts', library],
        [
          '/types.ts',
          "import { Shape } from './lib'\nexport interface Holder { shape: Shape }\nexport class Box implements Shape { size = 2 }\n"
        ]
      ])
    )
  )
  assert.deepEqual([...(found.get('/types.ts') ?? [])], ['./lib'])
})

test('one value use, a side-effect import, a re-export or a JavaScript importer keeps the implementation', () => {
  const found = elidedTypeImportSpecifiers(
    programOf(
      new Map([
        ['/lib.ts', library],
        ['/value.ts', "import { Shape, make } from './lib'\nexport const shape: Shape = make()\n"],
        ['/both.ts', "import type { Shape } from './lib'\nimport './lib'\nexport type S = Shape\n"],
        ['/reexport.ts', "import { Shape } from './lib'\nexport { Shape }\n"],
        ['/shadow.ts', "import { make } from './lib'\nexport const f = (make: number) => make\nexport const g = () => make\n"],
        ['/script.js', "import { Shape } from './lib'\nexport const n = 1\n"]
      ])
    )
  )
  assert.deepEqual([...found.keys()], [])
})

test('verbatimModuleSyntax keeps every value-syntax import', () => {
  const found = elidedTypeImportSpecifiers(
    programOf(
      new Map([
        ['/lib.ts', library],
        ['/types.ts', "import { type Shape } from './lib'\nexport interface Holder { shape: Shape }\n"]
      ]),
      { verbatimModuleSyntax: true, module: ts.ModuleKind.ESNext }
    )
  )
  assert.deepEqual([...found.keys()], [])
})
