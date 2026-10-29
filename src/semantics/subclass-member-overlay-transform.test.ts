import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { createSubclassMemberOverlayTransform } from './subclass-member-overlay-transform.js'
import { createProgram, defaultCompilerOptions } from './program.js'

const directory = resolve('test/fixtures/subclass-member-exports')
const base = resolve(directory, 'base.js')
const values = resolve(directory, 'values.js')

for (const inlineDefault of [false, true]) {
  test(`subclass member imports preserve module export bindings (${inlineDefault ? 'inline' : 'separate'} default)`, () => {
    const read = (file: string): string => {
      const text = readFileSync(file, 'utf8')
      return file === values && inlineDefault
        ? text.replace(
            'class DefaultValue extends ValueRoot {}\nexport default DefaultValue;',
            'export default class DefaultValue extends ValueRoot {}'
          )
        : text
    }
    const transform = createSubclassMemberOverlayTransform(read)
    const result = createProgram({
      rootFileNames: [base],
      projectFileName: null,
      options: { ...defaultCompilerOptions, types: [] },
      sourceOverlay: new Map([[values, read(values)]]),
      sourceTransforms: [transform]
    })
    const file = result.program.getSourceFile(base)
    assert.ok(file)
    assert.deepEqual(
      result.diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')),
      []
    )
    const declaration = file.statements.find(ts.isClassDeclaration)
    assert.ok(declaration)
    const type = result.checker.getTypeAtLocation(declaration)
    for (const [field, expected] of [
      ['defaultValue', 'DefaultValue'],
      ['namedValue', 'NamedValue'],
      ['aliasedValue', 'AliasedValue']
    ]) {
      const symbol = type.getProperty(field!)
      assert.ok(symbol, field)
      const value = result.checker.getTypeOfSymbolAtLocation(symbol, declaration)
      assert.equal(result.checker.typeToString(value), `${expected} | undefined`)
      const present = result.checker.getNonNullableType(value)
      assert.ok(present.getProperty('amount'), `${field} must resolve to its real class`)
    }
    assert.equal(type.getProperty('hiddenValue'), undefined, 'a private class must not become an invalid import')
    const record = type.getProperty('record')
    assert.ok(record)
    const recordType = result.checker.getNonNullableType(result.checker.getTypeOfSymbolAtLocation(record, declaration))
    const entry = recordType.getProperty('entry')
    assert.ok(entry)
    assert.equal(result.checker.typeToString(result.checker.getTypeOfSymbolAtLocation(entry, declaration)), 'DefaultValue')
    assert.equal(recordType.getProperty('hidden'), undefined)
  })
}

test('a program in a skipped directory is overlaid from its own module graph, not its neighbours', () => {
  // two independent programs side by side under `test/`, each with its own `Settings`: indexed together the name
  // is a duplicate and drops out, so the first program's overlay would depend on the second program existing
  const root = mkdtempSync(join(tmpdir(), 'subclass-overlay-'))
  try {
    writeFileSync(join(root, 'package.json'), '{}')
    mkdirSync(join(root, 'test'))
    const program = join(root, 'test', 'loud.js')
    const text = [
      'class Settings {}',
      'class LoudSettings extends Settings {',
      '  constructor() {',
      '    super()',
      '    this.isLoud = true',
      '  }',
      '}',
      '/** @param {Settings} settings */',
      'export const loud = (settings) => settings.isLoud',
      ''
    ].join('\n')
    writeFileSync(program, text)
    writeFileSync(join(root, 'test', 'quiet.js'), 'class Settings {}\nexport class QuietSettings extends Settings {}\n')
    const read = (file: string): string => readFileSync(file, 'utf8')
    for (const transform of [createSubclassMemberOverlayTransform(read), createSubclassMemberOverlayTransform(read, [program])]) {
      const overlaid = transform({ fileName: program, text })
      assert.ok(overlaid, 'the base the program reads through gains its subclass member')
      assert.match(overlaid, /@type \{boolean \| undefined\}[\s\S]*@geaSubclassMemberOverlay \*\/\n\tisLoud;/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
