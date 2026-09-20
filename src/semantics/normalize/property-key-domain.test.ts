import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createPropertyKeyDomains, domainMayNameNumeric } from './property-key-domain.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'

// Each declaration's initializer is the key expression under test; the
// parameters are typed so the domain reader sees `number` where three does.
const source = `
export function keys(index: number, indexArray: number, name: string, digits: number) {
  const underscore = index + '_' + indexArray
  const plain = index + indexArray
  const stringified = '' + index
  const template = \`\${index}_\${indexArray}\`
  const numericTemplate = \`\${index}.\${digits}\`
  const named = 'key_' + name
  const either = digits ? underscore : plain
  const dashed = index + '-' + indexArray
  const negative = '-' + index
  const exponent = index + 'e+' + digits
  return [underscore, plain, stringified, template, numericTemplate, named, either, dashed, negative, exponent]
}
`

const domainsOf = () => {
  const entry = resolve('test/fixtures/property-key-domain.ts')
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true }
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS)
      : getSourceFile(name, version, onError, fresh)
  const program = ts.createProgram({ rootNames: [entry], options, host })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const domains = createPropertyKeyDomains(checker, flow, () => true)
  const initializers = new Map<string, ts.Expression>()
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(node.name.text, node.initializer)
    ts.forEachChild(node, walk)
  }
  walk(file)
  return (name: string) => domainMayNameNumeric(domains.of(initializers.get(name)!))
}

test('a concatenation with an interior piece no canonical numeric string contains cannot name a numeric key', () => {
  const mayNameNumeric = domainsOf()
  // three's `WebGLUniformsGroups` cache key: two numbers around an underscore.
  assert.equal(mayNameNumeric('underscore'), false)
  assert.equal(mayNameNumeric('template'), false)
  assert.equal(mayNameNumeric('named'), false)
})

test('a concatenation whose every spelled piece can sit inside a numeric string still may name one', () => {
  const mayNameNumeric = domainsOf()
  assert.equal(mayNameNumeric('plain'), true)
  assert.equal(mayNameNumeric('stringified'), true)
  assert.equal(mayNameNumeric('numericTemplate'), true)
  assert.equal(mayNameNumeric('negative'), true)
  assert.equal(mayNameNumeric('exponent'), true)
  // Over-approximated on purpose: `-` sits inside `-1`, so the alphabet test alone cannot refuse `1-2`.
  assert.equal(mayNameNumeric('dashed'), true)
})

test('a branching key may name a numeric key when either branch may', () => {
  assert.equal(domainsOf()('either'), true)
})
