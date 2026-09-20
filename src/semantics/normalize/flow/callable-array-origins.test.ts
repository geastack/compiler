import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { callableArrayTargetsOf, closedCallableTargetsOf } from './callable-array-origins.js'

/** These tests supply explicit protocol/frame authorities to isolate storage
 * provenance. Integration must use the production authorities, never these
 * fixture permissions, for the corresponding complete-program proofs. */
const inspect = (source: string, native = true, frames = true, collections = false) => {
  const entry = resolve('test/fixtures/callable-array-origins.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const call = flow.calls.find(
    (site) => ts.isElementAccessExpression(site.call.expression) && site.call.expression.expression.getText(file) === 'callbacks'
  )?.call
  assert.ok(call && ts.isElementAccessExpression(call.expression))
  const bodies = callableArrayTargetsOf(checker, flow, call.expression, {
    arrayProtocolClosed: () => native,
    explicitInvocationIsIntact: () => native,
    parameterValuesOf: (parameter) =>
      frames
        ? flow
            .writesToDeclaration(parameter)
            .filter((write) => write.edge === 'call-argument' && write.value !== null)
            .map((write) => write.value!)
        : null,
    collectionValuesOf: () =>
      collections
        ? flow.allWrites.filter((write) => write.edge === 'collection-value' && write.value !== null).map((write) => write.value!)
        : null,
    collectionReadsOf: () =>
      collections
        ? flow.calls.flatMap((site) =>
            ts.isCallExpression(site.call) &&
            ts.isPropertyAccessExpression(site.call.expression) &&
            site.call.expression.name.text === 'get'
              ? [site.call]
              : []
          )
        : null
  })
  return bodies?.map((body) => (body.name && ts.isIdentifier(body.name) ? body.name.text : body.getText(file))) ?? null
}

test('native array aliases, append payloads and slice snapshots retain every callable origin', () => {
  const result = inspect(`function first(value) {} function second(value) {}
    const listeners = [first]; const alias = listeners; alias.push(second);
    const callbacks = alias.slice(0); callbacks[0]({});`)
  assert.deepEqual(new Set(result), new Set(['first', 'second']))
  assert.deepEqual(inspect(`function first(value) {} const callbacks = []; callbacks[0] = first; callbacks[0]({});`), ['first'])
  assert.deepEqual(inspect(`function first(value) {} const callbacks = [first]; callbacks.splice(0, 1); callbacks[0]({});`), ['first'])
})

test('listener parameter evidence requires an independently complete incoming frame', () => {
  const source = `function first(value) {} const callbacks = [];
    function add(listener) { callbacks.push(listener) } add(first); callbacks[0]({});`
  assert.deepEqual(inspect(source), ['first'])
  assert.equal(inspect(source, true, false), null)
  assert.equal(inspect(source, false), null)
})

test('map-held callback arrays require complete collection predecessor and continuation authority', () => {
  const source = `function first(value) {} const values = new Map<number, ((value: unknown) => void)[]>();
    const listeners = [first]; values.set(1, listeners);
    const callbacks = values.get(1)!.slice(0); callbacks[0]({});`
  assert.deepEqual(inspect(source, true, true, true), ['first'])
  assert.equal(inspect(source, true, true, false), null)
})

test('unknown writes, array exports and opaque alias uses never become partial target sets', () => {
  const start = 'function first(value) {} const callbacks = [first];'
  for (const extra of [
    'globalThis.external(callbacks);',
    'const alias = callbacks; globalThis.external(alias);',
    'callbacks[0] = globalThis.external;',
    'callbacks.push(globalThis.external);',
    'callbacks.slice = globalThis.external;',
    'Object.setPrototypeOf(callbacks, globalThis.external);',
    'export { callbacks };',
    'function escape() { return callbacks } globalThis.external(escape);'
  ])
    assert.equal(inspect(`${start} ${extra} callbacks[0]({});`), null, extra)
  assert.equal(inspect('function first(value) {} const callbacks = {0:first,length:1}; callbacks[0]({});'), null)
  assert.equal(inspect('let first = (value) => {}; first = globalThis.external; const callbacks = [first]; callbacks[0]({});'), null)
})

test('unallocated cyclic origins cannot borrow a separate branch allocation or callable', () => {
  assert.equal(
    inspect(`function first(value) {} declare const choose: boolean;
    let a: any; let b: any; a = b; b = a;
    const callbacks = choose ? a : [first]; callbacks[0]({});`),
    null
  )
  assert.equal(
    inspect(`function first(value) {} declare const choose: boolean;
    let a: any; let b: any; a = b; b = a;
    const callbacks = [choose ? a : first]; callbacks[0]({});`),
    null
  )
})

test('a closed Map storage cycle must have its own allocated callback array origin', () => {
  const source = `function first(value) {} const values = new Map<number, ((value: unknown) => void)[]>();
    let list = values.get(1);
    if (list === undefined) { list = []; values.set(1, list); }
    list.push(first);
    const callbacks = values.get(1)!.slice(0); callbacks[0]({});`
  assert.deepEqual(inspect(source, true, true, true), ['first'])
  assert.equal(inspect(source.replace('list = [];', ''), true, true, true), null)
})

/** Resolves the argument of the one `probe( ... )` call. `closedCallerSitesOf`
 * here accepts a named function only when every mention calls it. */
const probeTargets = (source: string, callers = true) => {
  const entry = resolve('test/fixtures/closed-callable-targets.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `function probe(value) {}\n${source}`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const probe = flow.calls.find((site) => site.call.expression.getText(file) === 'probe')?.call
  assert.ok(probe?.arguments?.[0])
  const bodies = closedCallableTargetsOf(checker, flow, probe.arguments[0], {
    parameterValuesOf: (parameter) =>
      flow
        .writesToDeclaration(parameter)
        .filter((write) => write.edge === 'call-argument' && write.value !== null)
        .map((write) => write.value!),
    ...(callers
      ? {
          closedCallerSitesOf: (callable: ts.SignatureDeclaration) => {
            if (!ts.isFunctionDeclaration(callable) || !callable.name) return null
            const calls: ts.CallExpression[] = []
            for (const reference of flow.referencesToDeclaration(callable)) {
              if (reference === callable.name) continue
              if (!ts.isCallExpression(reference.parent) || reference.parent.expression !== reference) return null
              calls.push(reference.parent)
            }
            return calls
          }
        }
      : {})
  })
  return bodies?.map((body) => (body.name && ts.isIdentifier(body.name) ? body.name.text : body.getText(file))).sort() ?? null
}

test('closed callable targets follow || defaults through a never-called setter', () => {
  // Three's `WebGLRenderList.sort( customOpaqueSort, ... )` fed from the
  // renderer's `_opaqueSort`, written only by an uncalled `setOpaqueSort`.
  const source = `function painterSortStable(a, b) { return 0 }
    function sort(customOpaqueSort) { probe(customOpaqueSort || painterSortStable) }
    let opaqueSort = null;
    function setOpaqueSort(method) { opaqueSort = method }
    sort(opaqueSort);`
  assert.deepEqual(probeTargets(source), ['painterSortStable'])
  assert.deepEqual(
    probeTargets(source.replace('sort(opaqueSort);', 'sort(opaqueSort); setOpaqueSort(function custom(a, b) { return 1 });')),
    ['custom', 'painterSortStable']
  )
  assert.equal(probeTargets(source.replace('sort(opaqueSort);', 'sort(opaqueSort); globalThis.external(setOpaqueSort);')), null)
  assert.equal(probeTargets(source, false), null)
  assert.deepEqual(probeTargets(source.replace('customOpaqueSort || painterSortStable', 'customOpaqueSort ?? painterSortStable')), [
    'painterSortStable'
  ])
})

test('vacuous callees name no body and unknown operands refuse', () => {
  assert.deepEqual(probeTargets('probe(null);'), [])
  assert.deepEqual(probeTargets('probe(undefined);'), [])
  assert.deepEqual(probeTargets('function first() {} declare const choose: boolean; probe(choose ? first : null);'), ['first'])
  assert.equal(probeTargets('function first() {} probe(first || globalThis.external);'), null)
  assert.equal(probeTargets('function first() {} probe(first && first);'), null)
  assert.equal(probeTargets('function first() {} let held = first; held = globalThis.external; probe(held);'), null)
})

test('extracted callable aliases retain contents only while every continuation closes', () => {
  const start = 'function first(value) {} const callbacks = [first];'
  for (const extra of [
    'const listener = callbacks[0]; listener({});',
    'const listener = callbacks[0]; const alias = listener; if(alias !== undefined) alias.call({}, {});'
  ])
    assert.deepEqual(inspect(`${start} ${extra} callbacks[0]({});`), ['first'])
  for (const extra of [
    'const listener = callbacks[0]; globalThis.external(listener);',
    'let listener = callbacks[0]; listener = globalThis.external; listener({});',
    'const listener = callbacks[0]; listener.call = globalThis.external;'
  ])
    assert.equal(inspect(`${start} ${extra} callbacks[0]({});`), null, extra)
})

test('recursive callable cells close on source bodies without borrowing another component seed', () => {
  const source = `function first() {} let a = first; let b = a; a = b; probe(a);`
  assert.deepEqual(probeTargets(source), ['first'])
  assert.deepEqual(probeTargets(source.replace('probe(a);', 'probe(b);')), ['first'])
  assert.equal(probeTargets(`function first() {} let a; let b; a = b; b = a; probe(a || first);`), null)
  assert.equal(probeTargets(source.replace('probe(a);', 'b = globalThis.external; probe(a);')), null)
})

const importedProbeTargets = (moduleSource: string, entrySource: string, declarationFile = false): string[] | null => {
  const entry = resolve('test/fixtures/callable-import-entry.ts')
  const imported = resolve(`test/fixtures/callable-import-source.${declarationFile ? 'd.ts' : 'ts'}`)
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const originalFileExists = host.fileExists.bind(host)
  const originalReadFile = host.readFile.bind(host)
  const originalSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (name) => resolve(name) === resolve(entry) || resolve(name) === resolve(imported) || originalFileExists(name)
  host.readFile = (name) => (resolve(name) === resolve(imported) ? moduleSource : originalReadFile(name))
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, entrySource, version, true)
      : resolve(name) === resolve(imported)
        ? ts.createSourceFile(name, moduleSource, version, true)
        : originalSourceFile(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const importedFile = program.getSourceFile(imported)
  assert.ok(importedFile)
  const flow = indexValueFlow(checker, [file, importedFile], wholeProgram)
  const call = flow.calls.find((site) => site.call.expression.getText(file) === 'probe')?.call
  assert.ok(call && ts.isCallExpression(call) && call.arguments[0])
  const bodies = closedCallableTargetsOf(checker, flow, call.arguments[0], {
    parameterValuesOf: () => null
  })
  return bodies?.map((body) => (body.name && ts.isIdentifier(body.name) ? body.name.text : body.getText())) ?? null
}

test('callable origins resolve named imported source functions and const arrows', () => {
  assert.deepEqual(
    importedProbeTargets(
      'export function first(value: unknown) {}',
      'import { first } from "./callable-import-source"; function probe(value: unknown) {} probe(first);'
    ),
    ['first']
  )
  assert.equal(
    importedProbeTargets(
      'export const first = (value: unknown) => {};',
      'import { first } from "./callable-import-source"; function probe(value: unknown) {} probe(first);'
    )?.length,
    1
  )
})

test('callable origins join known imported reassignments and refuse opaque replacement', () => {
  const known = importedProbeTargets(
    'export const second = (value: unknown) => {}; export let first = (value: unknown) => {}; first = second;',
    'import { first } from "./callable-import-source"; function probe(value: unknown) {} probe(first);'
  )
  assert.equal(known?.length, 2)
  assert.equal(
    importedProbeTargets(
      'declare const external: any; export let first = (value: unknown) => {}; first = external;',
      'import { first } from "./callable-import-source"; function probe(value: unknown) {} probe(first);'
    ),
    null
  )
})

test('callable origins refuse an ambient imported declaration without a source body', () => {
  assert.equal(
    importedProbeTargets(
      'export declare function first(value: unknown): void',
      'import { first } from "./callable-import-source"; function probe(value: unknown) {} probe(first);',
      true
    ),
    null
  )
})
