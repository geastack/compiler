import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
