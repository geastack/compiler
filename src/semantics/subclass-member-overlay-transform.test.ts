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
const child = resolve(directory, 'child.js')

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
      rootFileNames: [base, child],
      projectFileName: null,
      options: { ...defaultCompilerOptions, types: [] },
      sourceOverlay: new Map([[values, read(values)]]),
      sourceTransforms: [transform]
    })
    const file = result.program.getSourceFile(base)
    assert.ok(file)
    // `child.js` is part of the program now, and its read of `hiddenValue`
    // through a `Base` is the one member the overlay must not declare.
    assert.deepEqual(
      result.diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')),
      ["Property 'hiddenValue' does not exist on type 'Base'."]
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

for (const [install, overlaid] of [
  ["Node.prototype[ 'flip' + upper ] = function () { return this }", false],
  ["Node.prototype[ 'flop' + upper ] = function () { return this }", true],
  ['Object.defineProperty( Node.prototype, `flip${ upper }`, { value: 1 } )', false],
  ["Object.prototype[ 'flip' + upper ] = function () { return this }", false],
  ['Node.prototype[ 1 + upper ] = function () { return this }', true]
] as const) {
  test(`a prototype install whose key can be flipY decides its overlay: ${install}`, () => {
    // Virtual files under the compiler's own package root: the index reads
    // them through `read`, the program through `sourceOverlay`.
    const directory = resolve('test/fixtures/virtual-prototype-install')
    const texts = new Map([
      [resolve(directory, 'dispatcher.js'), 'export class EventDispatcher {}\n'],
      [
        resolve(directory, 'texture.js'),
        "import { EventDispatcher } from './dispatcher.js'\nexport class Texture extends EventDispatcher {\n  constructor() {\n    super()\n    /** @type {boolean} */\n    this.flipY = true\n    /** @type {boolean} */\n    this.isTexture = true\n  }\n}\n"
      ],
      [resolve(directory, 'node.js'), "import { EventDispatcher } from './dispatcher.js'\nexport class Node extends EventDispatcher {}\n"],
      [
        resolve(directory, 'install.js'),
        `import { Node } from './node.js'\n/** @param {string} upper */\nexport function install(upper) {\n  ${install}\n}\n/** @param {any} t */\nexport const flags = (t) => [t.flipY, t.isTexture]\n`
      ]
    ])
    const read = (file: string): string => {
      const text = texts.get(file)
      if (text === undefined) throw new Error(`no virtual file ${file}`)
      return text
    }
    const result = createProgram({
      rootFileNames: [...texts.keys()],
      projectFileName: null,
      options: { ...defaultCompilerOptions, types: [] },
      sourceOverlay: texts,
      sourceTransforms: [createSubclassMemberOverlayTransform(read)]
    })
    const file = result.program.getSourceFile(resolve(directory, 'dispatcher.js'))
    assert.ok(file)
    const declaration = file.statements.find(ts.isClassDeclaration)
    assert.ok(declaration)
    const type = result.checker.getTypeAtLocation(declaration)
    assert.ok(type.getProperty('isTexture'), 'a key no install can name keeps its overlay')
    assert.equal(type.getProperty('flipY') !== undefined, overlaid)
  })
}

test('a subclass in a file the program does not include declares nothing on its base', () => {
  // `child.js` shares the package with `base.js` and writes five members onto
  // `Base`, but a program rooted at `base.js` alone never loads it: its
  // classes are not declarers of anything this program holds.
  const result = createProgram({
    rootFileNames: [base],
    projectFileName: null,
    options: { ...defaultCompilerOptions, types: [] },
    sourceTransforms: [createSubclassMemberOverlayTransform((file) => readFileSync(file, 'utf8'))]
  })
  const file = result.program.getSourceFile(base)
  assert.ok(file)
  assert.equal(result.program.getSourceFile(child), undefined)
  const declaration = file.statements.find(ts.isClassDeclaration)
  assert.ok(declaration)
  assert.equal(result.checker.getTypeAtLocation(declaration).getProperty('defaultValue'), undefined)
})
