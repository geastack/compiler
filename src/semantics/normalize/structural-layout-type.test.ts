import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../../compiler.js'
import { createLayoutTypeResolver } from './structural-layout-type.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/structural-layout-type.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const layout = createLayoutTypeResolver(checker)
  const receivers = new Map<string, ts.Expression>()
  const declarations = new Map<string, ts.VariableDeclaration>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) receivers.set(node.getText(file), node.expression)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { checker, layout, receivers, declarations }
}

test('later document reads cannot replace an earlier Array.isArray view of a stated binding', () => {
  const { checker, layout, receivers } = inspect(`
    interface Doc { [key: string]: any }
    function parameter(hint?: string | Doc) {
      if (Array.isArray(hint)) hint.forEach(() => {});
      else if (hint != null && typeof hint === 'object') for (const key in hint) hint[key];
    }
    declare const incoming: string | Doc;
    let local: string | Doc = incoming;
    if (Array.isArray(local)) local.forEach(() => {});
    else if (typeof local === 'object') for (const key in local) local[key];
  `)
  for (const text of ['hint.forEach', 'local.forEach']) {
    const receiver = receivers.get(text)
    assert.ok(receiver, text)
    const raw = checker.getTypeAtLocation(receiver)
    assert.equal(checker.isArrayType(raw), true, text)
    assert.equal(layout(receiver) === raw, true, text)
  }
})

test('only an inferred empty array binding settles to its later concrete array element', () => {
  const { checker, layout, declarations } = inspect(`
    let values = [];
    values.push(7);
    const settled = values;
    const explicit: any[] = [];
    const explicitRead = explicit;
  `)
  const values = declarations.get('values')!
  const explicit = declarations.get('explicit')!
  // With no collection census, the empty literal has no element evidence.
  // The binding declaration is the evolving placeholder this resolver owns.
  assert.equal(checker.typeToString(layout(values.initializer!)), 'never[]')
  assert.equal(checker.typeToString(layout(values)), 'number[]')
  assert.equal(checker.typeToString(layout(explicit.initializer!)), 'any[]')
})

test('an annotated awaited array chooses element storage only for an authenticated unshared result', () => {
  const { checker, layout, declarations } = inspect(`
    class Source {
      held: any[] = [];
      async fresh(): Promise<any[]> { const values: any[] = []; values.push(1); return values; }
      async shared(): Promise<any[]> { return this.held; }
    }
    async function read(source: Source) {
      const fresh: number[] = await source.fresh();
      const shared: number[] = await source.shared();
      return [fresh, shared];
    }
  `)
  const fresh = declarations.get('fresh')!
  const shared = declarations.get('shared')!
  assert.equal(checker.typeToString(layout(fresh.initializer!)), 'number[]')
  assert.equal(checker.typeToString(layout(shared.initializer!)), 'any[]')
})

test('an open document array branch uses the native checked alias view in the full compiler', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/evolving-let-object-literal-hint.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.certification?.certified, true, JSON.stringify(result.certification?.refusals))
  assert.equal(result.emissionRefusals.length, 0, JSON.stringify(result.emissionRefusals))
  assert.equal(result.source !== null, true)
  assert.equal(result.source?.includes('gea::dictionary::aliasedObject'), true)
})

for (const [file, project] of [
  ['array-from-typed-array-local-carrier.runtime.js', 'array-from-typed-array-local-carrier.tsconfig.json'],
  ['await-any-array-into-annotated-binding.runtime.ts', 'tsconfig.json']
] as const)
  test(`the complete native array storage census remains authoritative for ${file}`, () => {
    const result = compile({
      rootFileNames: [resolve('test/runtime', file)],
      projectFileName: resolve('test/runtime', project),
      closedScriptScope: true
    })
    assert.equal(result.certification?.certified, true, JSON.stringify(result.certification?.refusals))
    assert.equal(result.emissionRefusals.length, 0, JSON.stringify(result.emissionRefusals))
    assert.equal(result.source !== null, true)
  })
