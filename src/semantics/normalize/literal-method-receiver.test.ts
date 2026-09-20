import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

/**
 * three's `ColorManagement`, reduced: a factory returns a record literal whose
 * own methods read `this.enabled` and store through `this.spaces`, and
 * `define( colorSpaces )` is called on it. Reading a data entry off `this` in
 * such a method is a data read only because `this` can be nothing but the
 * literal -- which is what the census has to prove before it binds a
 * parameter behind it.
 */
const censusOf = (source: string) => {
  const entry = resolve('test/fixtures/literal-method-receiver.js')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const parameterNamed = (name: string): ts.ParameterDeclaration => {
    let found: ts.ParameterDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) found ??= node
      ts.forEachChild(node, visit)
    }
    visit(file)
    return found!
  }
  return {
    bound: (name: string): string | null => {
      const type = census.typeAt(parameterNamed(name))
      return type === null ? null : checker.typeToString(type)
    },
    refusal: (name: string): string | null => census.refusalOf(parameterNamed(name))
  }
}

const colorManagement = (entry: (name: string, parameters: string, body: string) => string, tail = '') => `export {};
  function createColorManagement() {
    const ColorManagement = {
      enabled: true,
      workingColorSpace: 'linear',
      spaces: {},
      ${entry(
        'convert',
        'color, source, target',
        `
        if ( this.enabled === false || source === target ) return color;
        color.r = this.spaces[ source ].scale * color.r;
        return color;`
      )},
      ${entry('define', 'colorSpaces', 'Object.assign( this.spaces, colorSpaces );')},
      ${entry('workingToColorSpace', 'color, target', 'return this.convert( color, this.workingColorSpace, target );')}
    };
    ColorManagement.define( { linear: { scale: 1 }, srgb: { scale: 2 } } );
    return ColorManagement;
  }
  const ColorManagement = createColorManagement();
  ColorManagement.enabled = false;
  ColorManagement.workingToColorSpace( { r: 1 }, 'srgb' );
  ${tail}`

const shorthand = (name: string, parameters: string, body: string) => `${name}( ${parameters} ) { ${body} }`
const functionEntry = (name: string, parameters: string, body: string) => `${name}: function ( ${parameters} ) { ${body} }`

for (const [shape, entry] of [
  ['method shorthand', shorthand],
  ['function-valued entry', functionEntry]
] as const) {
  test(`a ${shape} reads its own literal's data entry through \`this\`, and the census binds behind it`, () => {
    const census = censusOf(colorManagement(entry))
    assert.equal(census.refusal('colorSpaces'), null)
    assert.notEqual(census.bound('colorSpaces'), null)
  })
}

test('a method read out of the literal as a value leaves its `this` unknown', () => {
  // `convert` leaves the record: `other` -- whose `enabled` is a getter that
  // can publish its own receiver -- becomes its `this`.
  const census = censusOf(
    colorManagement(
      shorthand,
      `const other = { spaces: {}, get enabled() { globalThis.leak( this ); return true } };
       const convert = ColorManagement.convert;
       convert.call( other, { r: 1 }, 'linear', 'srgb' );`
    )
  )
  assert.equal(census.bound('colorSpaces'), null)
})
