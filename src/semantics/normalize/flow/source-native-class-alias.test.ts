import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../../../compiler.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { wholeProgram } from '../reachability.js'
import { createLayoutTypeResolver } from '../structural-layout-type.js'
import { sourceNativeClassAliasTypeAt } from './source-native-class-alias.js'
import { indexValueFlow } from './value-flow.js'

const entry = resolve('test/fixtures/source-native-class-alias.ts')
const inspect = (source: string, module = true) => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry
      ? ts.createSourceFile(name, `${module ? 'export {};\n' : ''}${source}`, version, true)
      : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const declarations = new Map<string, ts.VariableDeclaration>()
  const accesses = new Map<string, ts.PropertyAccessExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node)
    if (ts.isPropertyAccessExpression(node)) accesses.set(node.getText(file), node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const nominate = (node: ts.Node) => ledger.capture(() => sourceNativeClassAliasTypeAt(checker, flow, node)).value
  const layout = createLayoutTypeResolver(checker, undefined, undefined, nominate)
  return { checker, declarations, accesses, nominate, layout }
}

const widget = `class Widget { label = 'widget'; describe = (suffix: string): string => this.label + suffix; }`

test('an immutable any alias, its erased initializer and its member reads retain the exact native class carrier', () => {
  for (const alias of ['const alias: any = original', 'const alias = original as any']) {
    const checked = inspect(
      `${widget} const original = new Widget(); ${alias}; alias.describe('one'); alias.describe === original.describe;`
    )
    const declaration = checked.declarations.get('alias')!
    const member = checked.accesses.get('alias.describe')!
    const expected = checked.checker.getTypeAtLocation(checked.declarations.get('original')!.initializer!)
    assert.equal(checked.nominate(declaration) === expected, true)
    assert.equal(checked.layout(declaration.initializer!) === expected, true)
    assert.equal(checked.layout(member.expression) === expected, true)
    assert.equal(checked.checker.typeToString(checked.layout(member)), '(suffix: string) => string')
  }
})

test('mutable aliases and mixed source class families cannot nominate a native class cell', () => {
  for (const alias of [
    'let alias: any = new Widget()',
    'const alias: any = flag ? new Widget() : new Other()',
    'const alias: any = flag ? new Widget() : undefined'
  ]) {
    const checked = inspect(`${widget} class Other { describe = (_suffix: string): string => 'other'; }
      declare const flag: boolean; ${alias}; alias.describe('one');`)
    assert.equal(checked.nominate(checked.declarations.get('alias')!), null, alias)
  }
})

test('an open Script alias cannot borrow a closed native class allocation family', () => {
  const checked = inspect(`${widget} const original = new Widget(); const alias: any = original; alias.describe('one');`, false)
  assert.equal(checked.nominate(checked.declarations.get('alias')!), null)
})

test('an opaque publication anywhere in the original allocation family revokes native alias nomination', () => {
  for (const exposure of ['publish(alias)', 'publish(original)', 'export { alias }']) {
    const checked = inspect(`${widget} declare function publish(value: unknown): void;
      const original = new Widget(); const alias: any = original; alias.describe('one'); ${exposure};`)
    assert.equal(checked.nominate(checked.declarations.get('alias')!), null, exposure)
  }
})

test('asserted class types and an unfilled generic class cannot fabricate a native source family', () => {
  for (const setup of [
    'declare const incoming: unknown; const alias: any = incoming as Widget;',
    'declare const incoming: Widget; const alias: any = incoming;',
    'function generic<T>(value: T) { class Box { held = value; } const alias: any = new Box(); alias.held; }'
  ]) {
    const checked = inspect(`${widget} ${setup}`)
    assert.equal(checked.nominate(checked.declarations.get('alias')!), null, setup)
  }
})

test('closed native class aliases preserve lazy callable field origins through the full compiler', () => {
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    includeIr: true,
    sourceOverlay: new Map([
      [
        entry,
        `export {}; ${widget} const original = new Widget(); const alias: any = original;
        console.log(alias.describe('first')); console.log(alias.describe === original.describe);`
      ]
    ])
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  assert.equal(
    (result.irBodies ?? []).some((body) =>
      [...body.blocks.values()].some((block) =>
        block.operations.some(
          (one) => one.kind === 'convert' && one.source.representation.kind === 'class-ref' && one.result.representation.kind === 'dynamic'
        )
      )
    ),
    false
  )
})
