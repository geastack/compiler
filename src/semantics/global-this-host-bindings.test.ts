import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../compiler.js'
import { noPluginCapabilities, type CompilerPlugin } from '../plugins/model.js'
import { createIdentityTable } from './normalize/identities.js'
import { indexValueFlow } from './normalize/flow/value-flow.js'
import { attachClosedScriptScope } from './normalize/flow/targets.js'
import { censusGlobalHostMutations, type GlobalHostMutationTaint } from './normalize/global-host-mutations.js'
import { censusParameterBindings } from './normalize/parameter-bindings.js'
import { wholeProgram } from './normalize/reachability.js'
import { censusUnresolvableNames } from './normalize/unresolvable-names.js'
import type { DeclarationId } from '../identity/ids.js'

const hostDeclaration = resolve('test/fixtures/global-this-host-bindings.d.ts')
const entry = resolve('test/fixtures/global-this-host-bindings.ts')
const builtinSource = resolve('test/fixtures/global-this-host-builtin.ts')
const processCarrier = 'test::Process'
const isolatedProject = resolve('test/runtime/inferred-array-index-absence.tsconfig.json')
const scaleFileName = resolve('test/fixtures/global-host-mutation-scale.ts')

type GlobalHostMutationAudit = {
  readonly taint: GlobalHostMutationTaint
  readonly bindings: ReadonlyMap<string, DeclarationId>
}

const globalHostMutationAuditOf = (
  source: string,
  hostNames: readonly string[] = ['hostProcess'],
  nativeReceiverNames: readonly string[] = [],
  publishedTypeProvider?: (checker: ts.TypeChecker, file: ts.SourceFile) => (expression: ts.Expression) => ts.Type,
  useSettledCalls = false,
  modules: ReadonlyMap<string, string> = new Map()
): GlobalHostMutationAudit => {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    moduleDetection: ts.ModuleDetectionKind.Legacy
  }
  const host = ts.createCompilerHost(options, true)
  const originalSourceFile = host.getSourceFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)
  const originalReadFile = host.readFile.bind(host)
  const sources = new Map([...modules, [scaleFileName, source]])
  // Resolve what the compiler asks for before consulting the map, the way
  // `semantics/program.ts` resolves both sides of a `sourceOverlay` key:
  // TypeScript spells every file name it handles with forward slashes, so on
  // a platform whose separator is not `/` the key never matched, the host fell
  // through to the real filesystem, and a source that exists only here was
  // reported missing.
  host.fileExists = (fileName) => sources.has(resolve(fileName)) || originalFileExists(fileName)
  host.readFile = (fileName) => sources.get(resolve(fileName)) ?? originalReadFile(fileName)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    sources.has(resolve(fileName))
      ? ts.createSourceFile(fileName, sources.get(resolve(fileName))!, languageVersion, true)
      : originalSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram({ rootNames: [scaleFileName], options, host })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(scaleFileName)
  assert.ok(file)
  const files = [...sources.keys()].map((name) => {
    const loaded = program.getSourceFile(name)
    assert.ok(loaded, `missing source module ${name}`)
    return loaded
  })
  const identities = createIdentityTable(program, checker)
  const bindings = new Map<string, DeclarationId>()
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !hostNames.includes(declaration.name.text)) continue
      const symbol = checker.getSymbolAtLocation(declaration.name)
      assert.ok(symbol)
      const binding = identities.symbolValueDeclarationId(symbol, declaration.name)
      if (binding === null) throw new Error(`missing host binding identity for ${declaration.name.text}`)
      bindings.set(declaration.name.text, binding)
    }
  }
  assert.deepEqual([...bindings.keys()].sort(), [...hostNames].sort())
  const nativeReceivers = new Set<DeclarationId>()
  const nativeReceiverSymbols = new Set<ts.Symbol>()
  const nativeConstructorSymbols = new Set<ts.Symbol>()
  for (const name of nativeReceiverNames) {
    const symbol = checker.resolveName(name, file, ts.SymbolFlags.Type, false)
    assert.ok(symbol, `missing native receiver type ${name}`)
    const declaration = identities.symbolDeclarationId(symbol, file)
    assert.ok(declaration, `missing native receiver identity ${name}`)
    nativeReceivers.add(declaration)
    nativeReceiverSymbols.add(symbol)
    const constructor = checker.resolveName(name, file, ts.SymbolFlags.Value, false)
    if (constructor) nativeConstructorSymbols.add(constructor)
  }
  const parameters = useSettledCalls ? censusParameterBindings(checker, files, wholeProgram) : null
  const flow = indexValueFlow(checker, files, wholeProgram, undefined, parameters?.callDeclarationAt, parameters?.callTargetsAt)
  // These programs are complete: the helper builds the whole program from
  // exactly these sources. Without that fact every top-level `const`/`class`
  // is a global lexical binding an unseen classic script could reach, so an
  // ordinary member call cannot prove its callee. Real compilation states the
  // same boundary (`ProgramInput.closedScriptScope`); see closed-script-scope.test.ts.
  attachClosedScriptScope(flow, { files: new Set(files) })
  const taint = censusGlobalHostMutations(
    checker,
    identities,
    files,
    censusUnresolvableNames(checker, files),
    new Set(bindings.values()),
    flow,
    wholeProgram,
    nativeReceivers,
    nativeReceiverSymbols,
    nativeConstructorSymbols,
    publishedTypeProvider?.(checker, file) ??
      (parameters ? (expression) => parameters.typeAt(expression) ?? checker.getTypeAtLocation(expression) : undefined)
  )
  return { taint, bindings }
}

const globalHostMutationTaintOf = (source: string): GlobalHostMutationTaint => globalHostMutationAuditOf(source).taint

test('deferred source completions retain observable global values for opaque consumers', () => {
  for (const declaration of [
    'function* produce() { yield globalThis }',
    'async function* produce() { yield globalThis }',
    'async function produce() { return globalThis }',
    'function produce() { if (Math.random()) return globalThis }'
  ]) {
    const source = `export {}; declare var hostProcess: object;
      declare function consume(value: unknown): void;
      ${declaration}
      consume(produce());`
    assert.ok(globalHostMutationTaintOf(source).has('*'), declaration)
    assert.equal(globalHostMutationTaintOf(source.replace('globalThis', '({ local: 1 })')).has('*'), false, declaration)
  }
})

test('erased generic constructor assertions retain the intrinsic callable identity', () => {
  for (const allocation of ['new (Map as new () => Map<string, number>)()', 'new (WeakMap as new () => WeakMap<object, number>)()']) {
    const audit = globalHostMutationAuditOf(`
      export {}
      declare var hostProcess: object
      const entries = ${allocation}
      entries.has(undefined as never)
    `)
    assert.deepEqual([...audit.taint], [], allocation)
  }
  const opaque = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare const construct: any
    const entries = new (construct as new () => Map<string, number>)()
    entries.has('key')
  ${globalReachesData}
  `)
  assert.ok(opaque.taint.surfaceKeys.every)
})

test('source data fields publish the provenance of their complete writes', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function sink(value: unknown): void
    class Owner {
      entries = new (Map as new () => Map<string, number>)()
      run() { const held = this.entries; held.set('key', 1); held.get('key'); sink(this.entries) }
    }
    new Owner().run()
  `)
  assert.equal(audit.taint.surfaceKeys.every, false)
  const replaced = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function unknownValue(): any
    class Owner {
      entries = new Map<string, number>()
      replace() { this.entries = unknownValue() }
      run() { this.entries.set('key', 1) }
    }
    const owner = new Owner(); owner.replace(); owner.run()
    ${globalReachesData}
  `)
  assert.equal(replaced.taint.surfaceKeys.every, true)
})

test('factory returned record holders retain borrowed Object tag provenance', () => {
  const source = `
    export {}
    declare var hostProcess: object
    function make(value: number) {
      const key = Symbol('same description')
      const object = { visible: value, [key]: value + 1 }
      return { object, key }
    }
    const first = make(1)
    delete first.object[first.key]
    console.log(Object.prototype.toString.call(first.object))
  `
  const audit = globalHostMutationAuditOf(source)
  assert.equal(audit.taint.has('*'), false)
  assert.equal(audit.taint.surfaceKeys.every, false)
  assert.deepEqual([...audit.taint], [])
  // Exercise the actual computed-symbol fixture, which also deletes nested
  // entries and checks borrowed tags on string and non-string symbol values.
  const result = compile({
    rootFileNames: [resolve('test/runtime/native-symbol-property-identity.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json')
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.doesNotMatch(result.source ?? '', /gea_cpp_value|gea::Value::box/)
})

test('stored intrinsic singleton identities survive structural local aliases', () => {
  const source = `
    export {}
    declare var hostProcess: object
    let selected = Math
    selected.max(1, 2)
  `
  assert.deepEqual([...globalHostMutationAuditOf(source).taint], [])
  const replaced = `${source.replace('selected.max', 'declare const replacement: any; selected = replacement; selected.max')}
${globalReachesData}`
  assert.ok(globalHostMutationAuditOf(replaced).taint.has('*'))
})

test('record holder provenance refuses opaque, replaced and accessor backed objects', () => {
  for (const source of [
    `
      export {}
      declare var hostProcess: object
      declare function external(value: unknown): void
      declare const replacement: any
      const holder = { object: {} }
      holder.object = replacement
      external(holder.object)
    `,
    `
      export {}
      declare var hostProcess: object
      declare function external(value: unknown): void
      const holder = { get object() { return globalThis } }
      external(holder.object)
    `
  ]) {
    assert.equal(
      globalHostMutationAuditOf(`${source}
${globalReachesData}`).taint.has('*'),
      true,
      source
    )
  }
})

test('a declaration-bound native class constructor preserves global alias provenance through a local wrapper', () => {
  for (const [setup, argument, wildcard] of [
    ['', 'new NativeView()', false],
    ['const Construct = NativeView;', 'new Construct()', false],
    ['', '(() => { const view = new NativeView(); view.touch(); return view })()', false],
    ['', 'globalThis as unknown as NativeView', true],
    [`declare const replacement: typeof NativeView; NativeView = replacement; ${globalReachesData}`, 'new NativeView()', true]
  ] as const) {
    const stop = new Error('native constructor provenance observed')
    let taint: readonly (DeclarationId | '*')[] | undefined
    const observer: CompilerPlugin = {
      name: 'native-constructor-provenance-test',
      instantiate: () => ({
        lower: () => false,
        capabilities: {
          ...noPluginCapabilities,
          nativeTypesByDeclaration: new Map([
            ['NativeView', { declarationName: 'NativeView', declarationFileName: hostDeclaration, native: 'test::View' }]
          ])
        },
        producers: (context) => {
          taint = [...context.globalHostMutationTaint]
          throw stop
        }
      })
    }
    assert.throws(
      () =>
        compile({
          rootFileNames: [entry, hostDeclaration],
          projectFileName: null,
          sourceOverlay: new Map([
            [hostDeclaration, 'declare class NativeView { touch(): void } declare function opaqueSink(value: unknown): void'],
            [entry, `${setup}\nfunction attach(view: NativeView) { opaqueSink(view) } attach(${argument})`]
          ]),
          plugins: [observer]
        }),
      (error: unknown) => error === stop
    )
    assert.ok(taint)
    assert.equal(taint.includes('*'), wildcard, `${setup} ${argument}`)
    if (!wildcard) assert.ok(taint.length > 0, 'the opaque sink can still reach inherited intrinsic prototypes')
  }
})

test('shared call attribution carries actual callee mutations before and after parameter settlement', () => {
  const source = `
    export {}
    interface Process {}
    declare var hostProcess: Process
    declare var otherProcess: Process
    class Writer { write(target) { target.hostProcess = undefined } }
    function invoke(receiver, target) { receiver.write(target) }
    invoke(new Writer(), globalThis)
  `
  const names = ['hostProcess', 'otherProcess']
  for (const settledCalls of [false, true]) {
    const audit = globalHostMutationAuditOf(source, names, [], undefined, settledCalls)
    assert.deepEqual([...audit.taint], [audit.bindings.get('hostProcess')])
  }
  // A script publishes invoke on the global object passed through its own
  // frame. Closed caller inference must not discard that publication.
  for (const settledCalls of [false, true])
    assert.ok(globalHostMutationAuditOf(source.replace('export {}', ''), names, [], undefined, settledCalls).taint.has('*'))
  for (const alternative of [
    'declare function opaque(): any; invoke(opaque(), globalThis)',
    'declare function external(target): void; invoke({ write: external }, globalThis)',
    'declare function external(target): void; Writer.prototype.write = external; invoke(new Writer(), globalThis)'
  ]) {
    for (const settledCalls of [false, true])
      assert.ok(globalHostMutationAuditOf(`${source}\n${alternative}`, names, [], undefined, settledCalls).taint.has('*'), alternative)
  }
})

test('settled receiver types inform publication without replacing global alias provenance', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    class Color { copy() { return this } }
    function update(color) { color.copy() }
    ${globalReachesDataQuietly}
  `
  const settledColorType = (checker: ts.TypeChecker, file: ts.SourceFile) => {
    const declaration = file.statements.find(ts.isClassDeclaration)!
    const colorType = checker.getTypeAtLocation(declaration)
    assert.equal(checker.typeToString(colorType), 'Color')
    return (expression: ts.Expression): ts.Type => {
      const checked = checker.getTypeAtLocation(expression)
      if (!ts.isIdentifier(expression) || expression.text !== 'color') return checked
      assert.ok((checked.flags & ts.TypeFlags.Any) !== 0)
      return colorType
    }
  }
  assert.ok(globalHostMutationAuditOf(source).taint.has('*'))
  assert.deepEqual([...globalHostMutationAuditOf(source, ['hostProcess'], [], settledColorType).taint], [])
  // A settled type is not permission to discard a known global alias, even
  // when the same parameter also receives a fresh instance.
  const mixed = `${source}\nupdate(new Color()); update(globalThis)`
  assert.ok(globalHostMutationAuditOf(mixed, ['hostProcess'], [], settledColorType).taint.has('*'))
  assert.ok(
    globalHostMutationAuditOf(`${source}\nupdate(globalThis as unknown as Color)`, ['hostProcess'], [], settledColorType).taint.has('*')
  )
  assert.ok(
    globalHostMutationAuditOf(
      `${source}\ndeclare function opaque(): any; update(new Color()); update(opaque())`,
      ['hostProcess'],
      [],
      settledColorType
    ).taint.has('*')
  )
})

const assertExactHostProcessTaint = (source: string): void => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      declare var otherProcess: Process
      ${source}
    `,
    ['hostProcess', 'otherProcess']
  )
  assert.deepEqual([...audit.taint], [audit.bindings.get('hostProcess')!])
}

/**
 * The whole-program precondition the census requires before it will read an
 * unplaced value as possibly the global object: some expression has to have
 * produced the global object as a VALUE and let it reach a position the alias
 * graph does not follow. A program that never mentions `globalThis` proves the
 * opposite, and then opacity cannot mean globality -- so a fixture whose
 * SUBJECT is "an opaque value stays fail-closed" has to state this, or what it
 * measures is the precondition rather than the opacity.
 *
 * Only ever added to a source a POSITIVE assertion reads. A negative one --
 * "this publishes, so nothing is tainted" -- is about a program with no global
 * in its data, and stating the escape there would change the question.
 */
const globalReachesData = 'declare function escapeGlobal(value: unknown): void; escapeGlobal(globalThis);'

/**
 * The same precondition, stated without a call.
 *
 * Handing the global object to an unknown callee also taints whatever that
 * callee could reach, which is fine where the assertion is "something is
 * tainted" and wrong where it names the taint set exactly. Storing it into a
 * field satisfies the precondition and adds nothing of its own.
 */
const globalReachesDataQuietly = 'const globalHolder: { value: unknown } = { value: null }; globalHolder.value = globalThis;'

const assertWildcardHostTaint = (source: string): void => {
  const taint = globalHostMutationTaintOf(`
    interface Process {}
    declare var hostProcess: Process
    ${globalReachesData}
    ${source}
  `)
  assert.ok(taint.has('*'), [...taint].join(','))
}

/**
 * A write of the key `hostProcess` through a receiver that may be the global
 * object may replace that binding. Its key is exact, so the census records the
 * binding (and the key on every surface) rather than the wildcard.
 */
const assertHostProcessMayBeWritten = (source: string): void => {
  const audit = globalHostMutationAuditOf(`
    interface Process {}
    declare var hostProcess: Process
    ${globalReachesData}
    ${source}
  `)
  assert.ok(audit.taint.has('*') || audit.taint.has(audit.bindings.get('hostProcess')!), [...audit.taint].join(','))
}

const assertOnlyGlobalHostMutationRefusal = (result: ReturnType<typeof compile>): void => {
  assert.equal(result.certificate, null)
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  const roots = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  assert.ok(roots.length > 0)
  assert.ok(
    roots.every((diagnostic) => /authenticated host global may be mutated through globalThis/.test(diagnostic.message)),
    JSON.stringify(roots)
  )
}

const plugin: CompilerPlugin = {
  name: 'global-this-host-binding-test',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      nativeTypesByDeclaration: new Map([
        ['Process', { declarationName: 'Process', declarationFileName: hostDeclaration, native: processCarrier }]
      ]),
      hostSingletonDeclarations: new Map([
        ['hostProcess', { declarationName: 'hostProcess', declarationFileName: hostDeclaration }],
        ['otherProcess', { declarationName: 'otherProcess', declarationFileName: hostDeclaration }]
      ]),
      hostNamespaces: {
        roots: new Set(['HostBuffer']),
        typeofs: new Map([['HostBuffer', 'function']]),
        methods: new Map([['HostBuffer.from', { kind: 'path', text: 'test::buffer_from' }]]),
        properties: new Map(),
        propertySetters: new Map()
      },
      hostNamespaceRootDeclarations: [{ declarationName: 'HostBuffer', declarationFileName: hostDeclaration }],
      hostNamespaceRootTypes: new Map([['HostBuffer', 'test::BufferConstructor']]),
      hostMethodBindings: new Map([
        [
          hostDeclaration,
          new Map([
            [
              'Process.getBuiltinModule',
              {
                protocol: processCarrier,
                member: 'getBuiltinModule',
                builtinModuleLookup: true
              }
            ]
          ])
        ]
      ]),
      commonJsBuiltinModules: new Map([
        ['known', 'known'],
        ['node:known', 'known']
      ]),
      commonJsBuiltinModuleSources: new Map([['known', builtinSource]]),
      hostMembers: new Map([
        [
          `${processCarrier}.getBuiltinModule`,
          {
            kind: 'method',
            arity: 1,
            emit: 'test::get_builtin_module({arg0})',
            result: 'dynamic'
          }
        ]
      ]),
      nativeIncludes: new Map([[processCarrier, '#include "test_process.hpp"']]),
      hostPreambles: new Map([['test::get_builtin_module({arg0})', ['#include "test_process.hpp"']]])
    }
  })
}

const nodeProcessPlugin: CompilerPlugin = {
  name: 'global-this-node-process-binding-test',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      nativeTypesByDeclaration: new Map([
        ['Process', { declarationName: 'Process', declarationFileName: hostDeclaration, native: processCarrier }]
      ]),
      hostSingletonDeclarations: new Map([['process', { declarationName: 'process', declarationFileName: hostDeclaration }]]),
      hostMethodBindings: new Map([
        [
          hostDeclaration,
          new Map([
            [
              'Process.getBuiltinModule',
              {
                protocol: processCarrier,
                member: 'getBuiltinModule',
                builtinModuleLookup: true
              }
            ]
          ])
        ]
      ]),
      hostMembers: new Map([
        [
          `${processCarrier}.getBuiltinModule`,
          {
            kind: 'method',
            arity: 1,
            emit: 'test::get_builtin_module({arg0})',
            result: 'dynamic'
          }
        ]
      ]),
      nativeIncludes: new Map([[processCarrier, '#include "test_process.hpp"']]),
      hostPreambles: new Map([['test::get_builtin_module({arg0})', ['#include "test_process.hpp"']]])
    }
  })
}

test('authenticated globalThis host properties resolve to their native bindings', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
      ],
      [builtinSource, 'export const retained = true'],
      [
        entry,
        `
        const same = hostProcess === globalThis.hostProcess
        const direct = hostProcess.getBuiltinModule('known')
        const viaGlobal = globalThis.hostProcess.getBuiltinModule('node:known')
        const viaComputed = globalThis['hostProcess'].getBuiltinModule('known')
        const buffer = globalThis['HostBuffer'].from('x')
        const missing = globalThis.hostProcess.getBuiltinModule('missing')
        const bson = globalThis?.hostProcess?.getBuiltinModule?.('known')?.startupSnapshot
        const distinct = hostProcess === otherProcess
        if (!same) throw new Error('same-singleton')
        if (distinct) throw new Error('distinct-singleton')
        ;(globalThis as any).expando = 1
        if ((globalThis as any).expando !== 1) throw new Error('expando')
        void [same, direct, viaGlobal, viaComputed, buffer, missing, bson, distinct]
      `
      ]
    ]),
    plugins: [plugin]
  })

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  const source = result.source ?? ''
  assert.equal((source.match(/test::get_builtin_module/g) ?? []).length, 5)
  assert.equal((source.match(/test::buffer_from/g) ?? []).length, 1)
  assert.match(source, /registerBuiltinModule\("known"/)
  assert.match(source, /= true;/)
  assert.equal((source.match(/= \(true\);/g) ?? []).length, 1)
  assert.equal((source.match(/= \(false\);/g) ?? []).length, 1)
  assert.doesNotMatch(source, /(?:getProperty|read)\([^\n]*"hostProcess"/)
  assert.doesNotMatch(source, /(?:getProperty|read)\([^\n]*"HostBuffer"/)
  assert.match(source, /gea::runtime::globalThis\(\)/)
})

test('BSON double-optional builtin lookup keeps the deferred host method through the trailing optional read', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: isolatedProject,
    statedModuleSet: true,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface SnapshotModule { startupSnapshot?: unknown } interface Process { getBuiltinModule?(id: string): SnapshotModule | undefined } declare var process: Process'
      ],
      [entry, "const bson = globalThis?.process?.getBuiltinModule?.('v8')?.startupSnapshot; void bson"]
    ]),
    plugins: [nodeProcessPlugin]
  })

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  const source = result.source ?? ''
  const hostCallLines = source.split('\n').filter((line) => line.includes('test::get_builtin_module'))
  assert.equal(hostCallLines.length, 1)
})

for (const [name, mutation] of [
  ['assignment', 'globalThis.hostProcess = otherProcess'],
  ['computed assignment', "globalThis['hostProcess'] = otherProcess"],
  ['delete', 'delete (globalThis as any).hostProcess'],
  ['defineProperty', "Object.defineProperty(globalThis, 'hostProcess', { value: otherProcess })"],
  ['computed literal Object.assign', "Object.assign(globalThis, { ['hostProcess']: otherProcess })"],
  ['getter Object.assign', 'Object.assign(globalThis, { get hostProcess() { return otherProcess } })'],
  ['globalThis identity replacement', 'globalThis.globalThis = globalThis'],
  ['aliased global object assignment', 'const root: any = globalThis; root.hostProcess = otherProcess'],
  ['typed aliased global object assignment', 'const root: { hostProcess: Process } = globalThis; root.hostProcess = otherProcess'],
  ['aliased Reflect.set', "const root: any = globalThis; Reflect.set(root, 'hostProcess', otherProcess)"],
  ['typed aliased Reflect.set', "const root: { hostProcess: Process } = globalThis; Reflect.set(root, 'hostProcess', otherProcess)"],
  ['aliased Object.defineProperty', "const root: any = globalThis; Object.defineProperty(root, 'hostProcess', { value: otherProcess })"],
  [
    'typed aliased Object.defineProperty',
    "const root: { hostProcess: Process } = globalThis; Object.defineProperty(root, 'hostProcess', { value: otherProcess })"
  ],
  ['aliased dynamic-key assignment', "const root: any = globalThis; const key: string = 'hostProcess'; root[key] = otherProcess"],
  ['parenthesized assignment target', '(globalThis.hostProcess) = otherProcess'],
  ['destructuring assignment target', '({ hostProcess: globalThis.hostProcess } = { hostProcess: otherProcess })'],
  ['for-of assignment target', 'for (globalThis.hostProcess of [otherProcess]) {}'],
  ['for-in assignment target', 'for ((globalThis as any).hostProcess in { key: 1 }) {}'],
  [
    'Reflect.set staged before Object.assign',
    "const patch: any = {}; Reflect.set(patch, 'hostProcess', otherProcess); Object.assign(globalThis, patch)"
  ],
  [
    'defineProperty staged before Object.assign',
    "const patch: any = {}; Object.defineProperty(patch, 'hostProcess', { value: otherProcess }); Object.assign(globalThis, patch)"
  ],
  [
    'Reflect.defineProperty staged before Object.assign',
    "const patch: any = {}; Reflect.defineProperty(patch, 'hostProcess', { value: otherProcess }); Object.assign(globalThis, patch)"
  ],
  [
    'Reflect.set staged before defineProperties',
    "const descriptors: any = {}; Reflect.set(descriptors, 'hostProcess', { value: otherProcess }); Object.defineProperties(globalThis, descriptors)"
  ],
  [
    'Reflect.set staged through object spread',
    "const patch: any = {}; Reflect.set(patch, 'hostProcess', otherProcess); Object.assign(globalThis, { ...patch })"
  ],
  [
    'aliased Object.defineProperty',
    "const root: any = globalThis; const define = Object.defineProperty; define(root, 'hostProcess', { value: otherProcess })"
  ]
] as const) {
  test(`authenticated bare and global host use is refused after ${name}`, () => {
    if (name === 'globalThis identity replacement') {
      assertWildcardHostTaint(mutation)
      return
    }
    if (name === 'Reflect.set staged before defineProperties') {
      assertExactHostProcessTaint(mutation)
      return
    }
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          hostDeclaration,
          'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
        ],
        [builtinSource, 'export const retained = true'],
        [entry, `${mutation}; const bare = hostProcess; const projected = globalThis.hostProcess; void [bare, projected]`]
      ]),
      plugins: [plugin]
    })

    assertOnlyGlobalHostMutationRefusal(result)
  })
}

for (const [name, source, tainted] of [
  [
    'a function object distinct from its return value',
    'function factory(): any { return globalThis } factory.hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ],
  [
    'a seeded recursive return SCC',
    'function first(): any { return second() } function second(): any { return first(); return globalThis } first().hostProcess = undefined; const bare = hostProcess; void bare',
    true
  ]
] as const) {
  test(`global alias graph separates ${name}`, () => {
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          hostDeclaration,
          'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
        ],
        [entry, source]
      ]),
      plugins: [plugin]
    })
    if (tainted) {
      assertOnlyGlobalHostMutationRefusal(result)
    } else {
      assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
      assert.deepEqual(result.loweringBlockers, [])
      assert.deepEqual(result.emissionRefusals, [])
    }
  })
}

for (const [name, mutation] of [
  ['object field', 'const holder = { root: globalThis }; holder.root.hostProcess = otherProcess'],
  ['array element', 'const holder = [globalThis]; holder[0].hostProcess = otherProcess'],
  [
    'dynamic container slot',
    "const holder: any = {}; const key: string = 'root'; holder[key] = globalThis; holder[key].hostProcess = otherProcess"
  ],
  ['object destructuring', 'const holder = { root: globalThis }; const { root } = holder; root.hostProcess = otherProcess'],
  ['array destructuring', 'const holder = [globalThis]; const [root] = holder; root.hostProcess = otherProcess'],
  ['destructuring assignment', 'let root: typeof globalThis; ({ root } = { root: globalThis }); root.hostProcess = otherProcess'],
  [
    'assignment chain',
    'const first = { root: globalThis }; let second = first; const third = { entry: second }; third.entry.root.hostProcess = otherProcess'
  ],
  [
    'local return',
    'function passthrough<T>(value: T): T { return value } const root = passthrough(globalThis); root.hostProcess = otherProcess'
  ],
  [
    'self container cycle',
    'const holder: any = {}; holder.self = holder; holder.root = globalThis; holder.self.root.hostProcess = otherProcess'
  ],
  [
    'mutual container cycle',
    'const left: any = {}; const right: any = {}; left.peer = right; right.peer = left; left.root = globalThis; right.peer.root.hostProcess = otherProcess'
  ],
  ['unknown call escape', 'declare function unknown(value: unknown): void; const holder = { root: globalThis }; unknown(holder)']
] as const) {
  test(`authenticated host globals are refused after globalThis flows through ${name}`, () => {
    if (name === 'dynamic container slot' || name === 'self container cycle' || name === 'mutual container cycle') {
      assertExactHostProcessTaint(mutation)
      return
    }
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          hostDeclaration,
          'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
        ],
        [builtinSource, 'export const retained = true'],
        [entry, `${mutation}; const bare = hostProcess; const projected = globalThis.hostProcess; void [bare, projected]`]
      ]),
      plugins: [plugin]
    })

    assertOnlyGlobalHostMutationRefusal(result)
  })
}

test('unrelated dynamic containers do not taint host-global bindings', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
      ],
      [builtinSource, 'export const retained = true'],
      [entry, 'const holder: any = {}; holder.root = {}; holder.root.hostProcess = undefined; const bare = hostProcess; void bare']
    ]),
    plugins: [plugin]
  })

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
})

test('primitive intrinsic results and native receivers do not invent global aliases', () => {
  for (const [name, expression] of [
    ['string includes', "'alpha\\nbeta'.includes('\\n')"],
    ['String.fromCharCode with typed-array index', 'String.fromCharCode(new Uint8Array([65])[0]!)'],
    ['typed-array subarray', 'new Uint8Array([65]).subarray(0)'],
    ['TextDecoder decode', 'new TextDecoder().decode(new Uint8Array([65]).subarray(0))']
  ] as const) {
    const audit = globalHostMutationAuditOf(
      `
        interface Process {}
        declare var hostProcess: Process
        ;(${expression} as any).hostProcess = undefined
        const bare = hostProcess
        void bare
      `,
      ['hostProcess'],
      ['Uint8Array', 'TextDecoder']
    )
    assert.deepEqual([...audit.taint], [], name)
  }
})

// `nativeResult`'s union branch used to require EVERY member to independently
// prove native, which an unauthenticated non-native member (here `string`,
// standing in for the `null` three.js's `_gl` actually carries -- this
// harness runs without `strictNullChecks`, under which `X | null` collapses
// to plain `X` before this code ever sees a union at all) never can. That
// made a reassigned local whose declared type is a native/primitive union --
// exactly the shape three.js's `_gl` has at any call the compiler had not
// already narrowed -- answer "not proven native" at every write, so an
// opaque sink receiving it was treated as though it might be handed the
// global object. A primitive member carries no identity that could BE the
// global object, so it must not veto a native answer the way an
// unauthenticated concrete member correctly does. The two writes below (a
// parameter and an unauthenticated call's result) must independently publish
// the SAME representation for the read to publish at all -- the write-
// consistency rule `publishedRepresentationOf` enforces -- so this exercises
// `nativeResult` at both write sites, not just one.
test('a reassigned native/primitive-union local is not treated as a possible global escape at an opaque call', () => {
  const audit = globalHostMutationAuditOf(
    `
      export {}
      interface Process {}
      declare var hostProcess: Process
      declare function external(value: unknown): void
      interface NativeReceiver {}
      declare function getReceiver(): NativeReceiver | string
      function relay(context: NativeReceiver | string) {
        let value: NativeReceiver | string = context
        value = getReceiver()
        external(value)
      }
      declare const p: NativeReceiver | string
      relay(p)
    `,
    ['hostProcess'],
    ['NativeReceiver']
  )
  assert.equal(audit.taint.has('*'), false, [...audit.taint].join(','))
})

// The fix above widens the union combinator to let a primitive member (which
// is what `null`/`undefined` are) stand aside, never to let an UNPROVEN
// concrete member ride along. `T | null` for an unconstrained generic `T` is
// the constructible case: unlike a literal `X | any` union (the checker
// always reduces that to plain `any` before this code ever sees it), TypeScript
// keeps `T` as a real, distinct union member with no collapse. `T` is neither
// primitive nor native nor a source class -- exactly the shape the fail-closed
// default exists for -- so the union must still refuse to publish, and the
// opaque sink must still be treated as a possible global escape.
test('an unconstrained generic union member still fails to publish and remains a possible global escape', () => {
  const audit = globalHostMutationAuditOf(
    `
      export {}
      interface Process {}
      declare var hostProcess: Process
      declare function external(value: unknown): void
      declare function opaque(): any
      function relay<T>(x: T | null) { external(x) }
      relay(opaque())
    ${globalReachesData}
    `,
    ['hostProcess']
  )
  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

test('a numeric typed-array index write does not invalidate its intrinsic methods', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      declare const index: number
      const bytes = new Uint8Array(4)
      bytes[index] = 65
      ;(bytes.subarray(0) as any).hostProcess = undefined
    `,
    ['hostProcess'],
    ['Uint8Array']
  )
  assert.deepEqual([...audit.taint], [])
})

test('a string-keyed typed-array patch invalidates intrinsic method trust', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      declare const key: string
      const bytes = new Uint8Array(4)
      ;(bytes as any)[key] = (() => globalThis) as any
      ;(bytes.subarray(0) as any).hostProcess = undefined
    ${globalReachesData}
    `,
    ['hostProcess'],
    ['Uint8Array']
  )
  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

test('a typed callback result publishes its primitive carrier through parameter flow', () => {
  const audit = globalHostMutationAuditOf(`
    interface Process {}
    declare var hostProcess: Process
    function fallback(): string { return 'value' }
    function inspect(format?: () => string): void {
      format ??= fallback
      const value = format()
      ;(value.includes('a') as any).hostProcess = undefined
    }
    inspect()
  `)
  assert.deepEqual([...audit.taint], [])
})

// `renderObject`/`renderObjects` mirror three.js's WebGLRenderer: a
// module-private helper with an unannotated parameter, called only by name
// from other module-private helpers, all the way back to a real allocation.
// Nobody ever reassigns `camera`, so the OLD rule ("no body write means no
// evidence") sealed every one of these to `OPAQUE_UNKNOWN` even though the
// value handed to the opaque `unknown()` sink is provably a fresh `Camera`
// instance, never `globalThis`. `enumeratedParameterValuesOf` closes exactly
// this gap by asking every closed caller what it actually passed. This does
// not assert an empty taint set outright: `camera`'s CHECKER type is still
// bare `any` (this fix carries provenance, not a type), so the pre-existing,
// unrelated `inheritedPrototypesOf` conservatism still lists Object/Array/Map/
// WeakMap as reachable intrinsics -- the one thing this fix answers is
// whether the call also wildcards on `containsGlobal`, and it must not.
test('an unannotated parameter carries call-site provenance instead of sealing to opaque', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function unknown(value: unknown): void
    class Camera {}
    function renderObject(camera) {
      unknown(camera)
    }
    function renderObjects(camera) {
      renderObject(camera)
    }
    renderObjects(new Camera())
  `)
  assert.equal(audit.taint.has('*'), false, [...audit.taint].join(','))
})

// The negative arm the soundness rule demands. `renderObject` is never
// CALLED anywhere in this program -- only passed as a bare VALUE to the
// opaque sink `unknown`, so `writesOf(camera)` is empty for the ordinary
// reason (no call site exists to attribute an argument to it at all, not
// merely "no reassignment"), and `enumeratedParameterValuesOf`'s own
// closed-caller proof (`flow/callable-reach.ts`'s `classifyMention`) must
// read that escape as an "open" mention and refuse to enumerate callers.
// Only a `null` from that proof may still seal `camera` to `OPAQUE_UNKNOWN`
// here; this is that path exercised for real, not merely asserted.
test('a parameter of a function passed as a value cannot be enumerated and still seals to opaque', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function unknown(value: unknown): void
    class Camera {}
    function renderObject(camera) {
      unknown(camera)
    }
    unknown(renderObject)
  ${globalReachesData}
  `)
  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

// Three's whole renderer is written as REVEALING MODULE factories:
// `function WebGLProperties() { ... return { get, remove } }`, allocated once
// with `new`, into a `let` slot declared in the enclosing constructor function
// and written from a nested `initGLContext()`. Every later `properties.remove(
// ... )` is a method call on that slot, and the census wildcarded all 102 of
// them in `WebGLRenderer.js` alone. What `new` yields here is the returned
// object LITERAL -- a fresh ordinary object allocated by this program, which
// can never be `globalThis` or an intrinsic surface -- so the receiver has a
// published representation and the call owes no wildcard.
//
// The method call takes no ARGUMENT deliberately. An unannotated parameter of a
// function installed on `this` cannot have its callers enumerated, so passing
// one would wildcard on `global contained in unknown call argument` and this
// test would be measuring the parameter root instead of the receiver one.
test('a revealing-module factory allocation reached through a nested-initializer slot publishes', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    function Properties() {
      const store = new WeakMap()
      return {
        get( object ) { return store.get( object ) },
        remove() { store.delete( store ) }
      }
    }
    function Renderer() {
      let properties
      function initContext() { properties = new Properties() }
      initContext()
      this.dispose = function () { properties.remove() }
    }
    new Renderer()
  `)
  assert.equal(audit.taint.has('*'), false, [...audit.taint].join(','))
})

// The negative arm: a slot whose writes do NOT agree on one allocation the
// program performs -- here one arm is a genuinely opaque host value -- must
// still seal. The rule above is "every write to this slot is a fresh
// allocation", never "this slot was written somewhere".
test('a nested-initializer slot written with an opaque value still seals to opaque', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function host(): any
    function Properties() {
      const store = new WeakMap()
      return { remove() { store.delete( store ) } }
    }
    function Renderer( useHost ) {
      let properties
      function initContext() { properties = useHost ? host() : new Properties() }
      initContext()
      this.dispose = function () { properties.remove() }
    }
    new Renderer( true )
  ${globalReachesData}
  `)
  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

test('a callable cast cannot publish a forged primitive result', () => {
  assertHostProcessMayBeWritten(`
    const forged = (() => globalThis) as any as (() => string)
    ;(forged() as any).hostProcess = undefined
  `)
})

for (const [name, source] of [
  [
    'primitive',
    `
      interface Process {}
      declare var hostProcess: Process
      function forged(): string { return globalThis as any }
      ;(forged() as any).hostProcess = undefined
    `
  ],
  [
    'native',
    `
      interface Process {}
      declare var hostProcess: Process
      function forged(): Uint8Array { return globalThis as any }
      ;(forged().subarray(0) as any).hostProcess = undefined
    `
  ]
] as const) {
  test(`a local callable body cannot forge ${name} result provenance with its annotation`, () => {
    const audit = globalHostMutationAuditOf(source, ['hostProcess'], ['Uint8Array'])
    assert.ok(audit.taint.size > 0, [...audit.taint].join(','))
  })
}

test('an ambient native constructor publishes the BSON TextDecoder shape', () => {
  const audit = globalHostMutationAuditOf(
    `
      export {}
      interface Process {}
      declare var hostProcess: Process
      type TextDecoder = { decode(input?: Uint8Array): string }
      type TextDecoderConstructor = { new(label: 'utf8', options: { fatal: boolean }): TextDecoder }
      declare const TextDecoder: TextDecoderConstructor
      let decoder: TextDecoder
      decoder ??= new TextDecoder('utf8', { fatal: true })
      const bytes = new Uint8Array(4)
      ;(decoder.decode(bytes.subarray(0)) as any).hostProcess = undefined
    `,
    ['hostProcess'],
    ['Uint8Array', 'TextDecoder']
  )
  assert.deepEqual([...audit.taint], [])
})

test('ordinary local and native receiver calls do not taint host globals', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      class LocalValue { text(): string { return 'local' } }
      const local = new LocalValue()
      const bytes = new Uint8Array([65])
      local.text().includes('o')
      bytes.subarray(0).fill(0)
    `,
    ['hostProcess'],
    ['Uint8Array']
  )
  assert.deepEqual([...audit.taint], [])
})

// `fetch`/`Response` would resolve to lib.dom's declarations (a `Promise<Response>`
// result), so the host protocol is spelled under names the library does not own.
test('a native call result keeps its native receiver provenance, awaited or not', () => {
  for (const spelling of ['hostFetch(url)', 'await hostFetch(url)']) {
    const audit = globalHostMutationAuditOf(
      `
        interface Process {}
        declare var hostProcess: Process
        interface HostResponse { text(): string }
        declare function hostFetch(url: string): HostResponse
        async function load(url: string): Promise<string> {
          const response = ${spelling}
          return response.text()
        }
      `,
      ['hostProcess'],
      ['HostResponse']
    )
    assert.equal(audit.taint.has('*'), false, spelling)
    assert.equal(audit.taint.has(audit.bindings.get('hostProcess')!), false, spelling)
    assert.ok(audit.taint.size > 0, 'native result provenance does not erase opaque argument prototype effects')
  }
})

test('a host overload merged onto a library symbol publishes the result the call resolved to', () => {
  // `fetch` is lib.dom's symbol too; the host's `declare global` overload is
  // the one this call resolves to (`HostInit` shares no property with
  // `RequestInit`, so the library overload does not apply). Every-overload
  // judgement refused it on the strength of lib.dom's `Promise<Response>`.
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      interface HostInit { retries: number }
      interface HostResponse { text(): string }
      declare global {
        function fetch(url: string, init: HostInit): HostResponse
      }
      async function load(url: string): Promise<string> {
        const response = await fetch(url, { retries: 1 })
        const raw = await response.text()
        return raw.trim()
      }
      export {}
    `,
    ['hostProcess'],
    ['HostResponse']
  )
  assert.equal(audit.taint.has('*'), false)
  assert.equal(audit.taint.has(audit.bindings.get('hostProcess')!), false)
  assert.ok(audit.taint.size > 0, 'the opaque host overload receives values whose prototypes remain reachable')
})

test('authenticated static intrinsic calls accept primitive and native arguments', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      const bytes = new Uint8Array([65])
      String.fromCharCode(bytes[0]!)
      ArrayBuffer.isView(bytes)
    `,
    ['hostProcess'],
    ['Uint8Array']
  )
  assert.deepEqual([...audit.taint], [])
})

for (const [name, invocation] of [
  ['call', 'String.fromCharCode.call(String, 65)'],
  ['apply', 'String.fromCharCode.apply(String, [65])'],
  ['const alias', '(() => { const from = String.fromCharCode; return from(65) })()'],
  ['bind', 'String.fromCharCode.bind(String)(65)']
] as const) {
  test(`authenticated intrinsic invocation through ${name} retains callable provenance`, () => {
    const audit = globalHostMutationAuditOf(`
      interface Process {}
      declare var hostProcess: Process
      ;(${invocation} as any).hostProcess = undefined
    `)
    assert.deepEqual([...audit.taint], [])
  })
}

test('call and bind preserve unsafe explicit receiver provenance', () => {
  assertWildcardHostTaint(`
    Uint8Array.prototype.subarray.call(globalThis as any, 0)
    Uint8Array.prototype.subarray.bind(globalThis as any)(0)
  `)
})

test('a genuinely opaque method receiver remains fail-closed', () => {
  assertWildcardHostTaint(`
    declare const opaque: unknown
    ;(opaque as any).method()
  `)
})

test('an equivalent authenticated global remains fail-closed as a method receiver', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      declare var window: typeof globalThis
      window.toString()
    `,
    ['hostProcess', 'window']
  )
  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

// pino's `lib/transport.js`: `globalThis.hasOwnProperty('__bundlerPathsOverrides')`.
// The receiver IS the global object, so which body runs is decided by the key
// `hasOwnProperty` on it and on Object.prototype -- the census's own per-key
// answer -- and the intrinsic reads one own slot without running any code.
test('an own-key test on the proven global object with a literal key does not wildcard the census', () => {
  const audit = globalHostMutationAuditOf(`
    interface Process {}
    declare var hostProcess: Process
    globalThis.hasOwnProperty('zz')
  `)
  assert.equal(audit.taint.has('*'), false, [...audit.taint].join(','))
  assert.equal(audit.taint.has(audit.bindings.get('hostProcess')!), false)
})

test('an own-key test on the global object stays fail-closed once its key may not reach the intrinsic', () => {
  for (const spelling of [
    ';(globalThis as any).hasOwnProperty = () => true',
    "Object.defineProperty(globalThis, 'hasOwnProperty', { value: () => true })",
    'Object.prototype.hasOwnProperty = function () { return true }',
    ';(Object.getPrototypeOf(globalThis) as any).hasOwnProperty = () => true',
    'var hasOwnProperty = () => true',
    'declare const key: any; globalThis.hasOwnProperty(key)'
  ]) {
    const audit = globalHostMutationAuditOf(`
      interface Process {}
      declare var hostProcess: Process
      ${spelling}
      globalThis.hasOwnProperty('zz')
    `)
    assert.ok(audit.taint.has('*'), spelling)
  }
})

test('a local receiver cast from the global object does not acquire object provenance', () => {
  assertWildcardHostTaint(`
    class LocalValue { text(): string { return 'local' } }
    const local: LocalValue = globalThis as any
    local.text()
  `)
})

// `hono-bridge`'s false positive: `@hono/node-server`'s own `context.ts` spells
// a parameter type as `globalThis.ResponseInit` -- a dotted TYPE reference
// (`ts.QualifiedName`), never a read of `globalThis` as a value. `ts.isExpression`
// is a pure syntax-kind test and answered `true` for that qualifier anyway
// (`Identifier` is one shared node kind for both roles), so the census took it
// as its one piece of evidence for what `globalThis` IS, and
// `checker.getTypeAtLocation` on a TYPE qualifier -- which never needs
// `globalThis`'s VALUE type to resolve a member lookup -- answered `any`. An
// `any` `intrinsicGlobalType` makes every host binding whatsoever look
// "assignable to the global object" (`isAuthenticatedEquivalentGlobal`),
// authenticating `Buffer`/`Request`/every other host singleton as `globalThis`
// itself and wildcarding the whole census the moment ANY of them is called as
// a method (`Buffer.from(...)`, `Buffer.isBuffer(...)`) -- with no mutation,
// dynamic callee, or reflection anywhere in the program.
test('a dotted globalThis TYPE reference does not seed a bogus equivalent-global identity', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      interface ResponseInit {}
      interface HostBufferConstructor { isBuffer(value: unknown): boolean }
      declare const HostBuffer: HostBufferConstructor
      function build(init?: globalThis.ResponseInit): void {}
      HostBuffer.isBuffer('x')
    `,
    ['hostProcess', 'HostBuffer']
  )
  assert.equal(audit.taint.has('*'), false, [...audit.taint].join(','))
})

for (const [wrapper, invocation] of [
  ['call', 'String.fromCharCode.call(String, 65)'],
  ['apply', 'String.fromCharCode.apply(String, [65])'],
  ['bind', 'String.fromCharCode.bind(String)(65)']
] as const) {
  test(`patched Function.prototype.${wrapper} invalidates callable provenance`, () => {
    assertHostProcessMayBeWritten(`
      Function.prototype.${wrapper} = (() => globalThis) as any
      ;(${invocation} as any).hostProcess = undefined
    `)
  })
}

test('opaque wrapper exposure revokes deferred source invocation closure', () => {
  for (const exposed of [false, true]) {
    const audit = globalHostMutationAuditOf(`
      export {}
      interface Process {}
      declare var hostProcess: Process
      declare function external(value: unknown): void
      function listener(this: object, value: unknown) {}
      const callbacks = [listener]
      const held = callbacks[0]
      ${exposed ? 'external(Function.prototype)' : ''}
      held.call({}, globalThis)
    `)
    assert.equal(audit.taint.has('*'), exposed)
  }
})

test('own-key reflection dependencies revoke source slot closure after method replacement', () => {
  for (const replaced of [false, true]) {
    const audit = globalHostMutationAuditOf(`
      export {}
      declare var hostProcess: object
      declare const replacement: typeof Object.keys
      class Owner { run = (value: unknown) => {} }
      const owners = [new Owner()]
      const owner = [...owners][0]!
      ${replaced ? 'Object.keys = replacement' : ''}
      Object.keys(owner)
      'run' in owner
      owner.run(globalThis)
    `)
    assert.equal(audit.taint.has('*'), replaced)
  }
})

test('a patched native host method invalidates its result provenance', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      TextDecoder.prototype.decode = (() => globalThis) as any
      ;(new TextDecoder().decode(new Uint8Array(1)) as any).hostProcess = undefined
    `,
    ['hostProcess'],
    ['Uint8Array', 'TextDecoder']
  )
  assert.ok(audit.taint.has('*') || audit.taint.has(audit.bindings.get('hostProcess')!), [...audit.taint].join(','))
})

test('frontend supplies the represented receiver proof to the host-global census', () => {
  for (const [name, expression] of [
    ['string method', "'alpha\\nbeta'.includes('\\n')"],
    ['typed-array subarray', 'new Uint8Array([65]).subarray(0)'],
    ['TextDecoder construction', 'new TextDecoder()'],
    ['TextDecoder decode', 'new TextDecoder().decode(new Uint8Array([65]).subarray(0))'],
    ['String.fromCharCode', 'String.fromCharCode(new Uint8Array([65])[0]!)']
  ] as const) {
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [hostDeclaration, 'interface Process {} declare var hostProcess: Process'],
        [entry, `const value = ${expression}; const bare = hostProcess; void [value, bare]`]
      ]),
      plugins: [plugin]
    })
    const hostMutation = result.diagnostics.diagnostics.filter((diagnostic) =>
      /authenticated host global may be mutated through globalThis/.test(diagnostic.message)
    )
    assert.deepEqual(hostMutation, [], `${name}: ${JSON.stringify(hostMutation)}`)
  }
})

test('a real global escape through an asserted native receiver remains fail-closed', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      const bytes: Uint8Array = globalThis as any
      const decoder = new TextDecoder()
      decoder.decode(bytes.subarray(0))
      const bare = hostProcess
      void bare
    `,
    ['hostProcess'],
    ['Uint8Array', 'TextDecoder']
  )

  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

// `calleeHasNoKeySetEffect` in `global-host-mutations.ts` clears the
// receiver-wildcard for a member call the checker resolved to a
// key-set-inert standard-library declaration (`sort`/`has`/`add`/`slice`/
// `subarray`) -- three's `attribute.updateRanges.sort(...)` and
// `materialShaders.has/add(...)` reach the census exactly this way: an
// unannotated JS value the checker still types concretely, but that never
// earns a `publishedRepresentationOf` proof. The two tests below are the
// sound/unsound pair the hard constraint on this rule requires: clearing
// must depend on the CALLEE's specified effect, never on the receiver's
// name or shape, so a receiver the alias graph traced to the real global
// object must still wildcard even through the identical method name.
test('a checker-resolved key-set-inert standard-library method still wildcards a real global escape', () => {
  const audit = globalHostMutationAuditOf(`
    interface Process {}
    declare var hostProcess: Process
    const ranges: { start: number; count: number }[] = globalThis as any
    ranges.sort((a, b) => a.start - b.start)
    const bare = hostProcess
    void bare
  `)
  assert.ok(audit.taint.has('*'), [...audit.taint].join(','))
})

test('a user object cast to Uint8Array does not acquire native receiver provenance', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      const forged = ({ subarray() { return globalThis } } as any) as Uint8Array
      ;(forged.subarray(0) as any).hostProcess = undefined
    `,
    ['hostProcess'],
    ['Uint8Array']
  )

  assert.ok(audit.taint.has('*') || audit.taint.has(audit.bindings.get('hostProcess')!), [...audit.taint].join(','))
})

for (const [name, mutation] of [
  [
    'overwritten String.fromCharCode',
    `
      const replacement = (() => globalThis) as any as typeof String.fromCharCode
      String.fromCharCode = replacement
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'overwritten Uint8Array.prototype.subarray',
    `
      const replacement = (() => globalThis) as any as typeof Uint8Array.prototype.subarray
      Uint8Array.prototype.subarray = replacement
      ;(new Uint8Array(1).subarray(0) as any).hostProcess = undefined
    `
  ],
  [
    'reassigned typed intrinsic alias',
    `
      let fromCharCode = String.fromCharCode
      fromCharCode = (() => globalThis) as any as typeof fromCharCode
      ;(fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'mutable typed intrinsic alias',
    `
      let fromCharCode = String.fromCharCode
      ;(fromCharCode(65) as any).hostProcess = undefined
    `
  ]
] as const) {
  test(`${name} cannot use the represented-result exemption`, () => assertHostProcessMayBeWritten(mutation))
}

for (const [name, mutation] of [
  [
    'Object.defineProperties replacement',
    `
      Object.defineProperties(String, {
        fromCharCode: { value: (() => globalThis) as any as typeof String.fromCharCode }
      })
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'Object.defineProperties dynamic descriptor source',
    `
      declare const descriptors: PropertyDescriptorMap
      Object.defineProperties(String, descriptors)
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'Object.defineProperty dynamic intrinsic key',
    `
      declare const key: PropertyKey
      Object.defineProperty(String, key, { value: (() => globalThis) as any })
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'dynamic static property patch',
    `
      declare const key: PropertyKey
      ;(String as any)[key] = (() => globalThis) as any
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'dynamic static property patch through constructor alias',
    `
      const StringAlias = String
      declare const key: PropertyKey
      ;(StringAlias as any)[key] = (() => globalThis) as any
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ],
  [
    'dynamic native prototype patch through alias',
    `
      const prototypeAlias = Uint8Array.prototype
      declare const key: PropertyKey
      ;(prototypeAlias as any)[key] = (() => globalThis) as any
      ;(new Uint8Array(1).subarray(0) as any).hostProcess = undefined
    `
  ],
  [
    'mutable reflective mutator alias',
    `
      let patch = Object.defineProperty
      declare const replacement: typeof Object.defineProperty
      patch = replacement
      patch(String, 'fromCharCode', { value: (() => globalThis) as any })
      ;(String.fromCharCode(65) as any).hostProcess = undefined
    `
  ]
] as const) {
  test(`${name} invalidates intrinsic result trust`, () => assertHostProcessMayBeWritten(mutation))
}

for (const alias of ['global', 'window', 'self'] as const) {
  test(`authenticated equivalent global object ${alias} carries GLOBAL_TRUE`, () => {
    const audit = globalHostMutationAuditOf(
      `
        interface Process {}
        declare var hostProcess: Process
        declare var ${alias}: typeof globalThis
        ${alias}.hostProcess = undefined
      `,
      ['hostProcess', alias]
    )
    assert.deepEqual([...audit.taint], [audit.bindings.get('hostProcess')!])
  })

  test(`authenticated globalThis.${alias} selector carries GLOBAL_TRUE`, () => {
    const audit = globalHostMutationAuditOf(
      `
        interface Process {}
        declare var hostProcess: Process
        declare var ${alias}: typeof globalThis
        globalThis.${alias}.hostProcess = undefined
      `,
      ['hostProcess', alias]
    )
    assert.deepEqual([...audit.taint], [audit.bindings.get('hostProcess')!])
  })
}

test('globalThis selector spelling without exact host provenance is not GLOBAL_TRUE', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      ;(globalThis as any).window.hostProcess = undefined
      const bare = hostProcess
      void bare
    `,
    ['hostProcess']
  )
  assert.deepEqual([...audit.taint], [])
})

test('a global-like spelling without exact host provenance is not GLOBAL_TRUE', () => {
  const audit = globalHostMutationAuditOf(`
    interface Process {}
    declare var hostProcess: Process
    const global = {} as { hostProcess?: Process }
    global.hostProcess = undefined
    const bare = hostProcess
    void bare
  `)
  assert.deepEqual([...audit.taint], [])
})

test('an authenticated host binding without globalThis-equivalent type is not GLOBAL_TRUE', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      interface HostScope { hostProcess?: Process }
      declare var hostProcess: Process
      declare var global: HostScope
      global.hostProcess = undefined
      const bare = hostProcess
      void bare
    `,
    ['hostProcess', 'global']
  )
  assert.deepEqual([...audit.taint], [])
})

for (const [name, source] of [
  ['assignment', 'const root: any = globalThis; root.nonHostExpando = 1'],
  ['Object.defineProperties literal', 'const root: any = globalThis; Object.defineProperties(root, { nonHostExpando: { value: 1 } })']
] as const) {
  test(`an exact non-host expando through ${name} does not wildcard-taint`, () => {
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          hostDeclaration,
          'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
        ],
        [entry, `${source}; const bare = hostProcess; void bare`]
      ]),
      plugins: [plugin]
    })

    assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
    assert.deepEqual(result.loweringBlockers, [])
    assert.deepEqual(result.emissionRefusals, [])
  })
}

test('a constant computed Object.assign key remains exact', () => {
  assert.deepEqual(
    [
      ...globalHostMutationTaintOf(`
        interface Process {}
        declare var hostProcess: Process
        Object.assign(globalThis, { ['nonHostExpando']: 1 })
      `)
    ],
    []
  )
})

test('an exact host mutation taints only that host declaration', () => {
  const audit = globalHostMutationAuditOf(
    `
      interface Process {}
      declare var hostProcess: Process
      declare var otherProcess: Process
      globalThis.hostProcess = otherProcess
    `,
    ['hostProcess', 'otherProcess']
  )
  const hostProcess = audit.bindings.get('hostProcess')
  assert.ok(hostProcess)
  assert.deepEqual([...audit.taint], [hostProcess])
  assert.equal(audit.taint.has('*'), false)
  assert.equal(audit.taint.has(audit.bindings.get('otherProcess')!), false)
})

test('an opaque route remains fail-closed beside a GLOBAL_TRUE route', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    declare function unknown(): any
    const root: any = Math.random() ? globalThis : unknown()
    Object.assign(root, { nonHostExpando: 1 })
    Object.defineProperties(root, { anotherExpando: { value: 1 } })
    root.nonHostExpando = 2
    const bare = hostProcess
    void bare
  `
  // The opaque route may be any intrinsic or the global object: every key it
  // writes is recorded on every surface. None of them names a host binding.
  const taint = globalHostMutationTaintOf(source)
  assert.deepEqual([...taint], [])
  assert.equal(taint.surfaceKeys.every, false)
  assert.deepEqual([...taint.surfaceKeys.names].sort(), ['anotherExpando', 'nonHostExpando'])
})

test('a computed key the key-set authority proves is written exactly', () => {
  // `key` is bound once, to a literal: the census writes exactly that key on
  // the global object, and it names no host binding.
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [hostDeclaration, 'interface Process {} declare var hostProcess: Process; declare var otherProcess: Process'],
      [entry, "const root: any = globalThis; const key: string = 'nonHostExpando'; root[key] = 1; const bare = hostProcess; void bare"]
    ]),
    plugins: [plugin]
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  // The same binding naming the host key refuses the bare read.
  const hostKey = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [hostDeclaration, 'interface Process {} declare var hostProcess: Process; declare var otherProcess: Process'],
      [entry, "const root: any = globalThis; const key: string = 'hostProcess'; root[key] = 1; const bare = hostProcess; void bare"]
    ]),
    plugins: [plugin]
  })
  assertOnlyGlobalHostMutationRefusal(hostKey)
})

test('an unresolved call result writing an exact key records only that key', () => {
  const audit = globalHostMutationAuditOf(`
    interface Process {}
    declare var hostProcess: Process
    declare function unknown(): any
    ${globalReachesDataQuietly}
    unknown().nonHostExpando = 1
    new (unknown())().otherExpando = 1
  `)
  assert.deepEqual([...audit.taint], [])
  assert.deepEqual([...audit.taint.surfaceKeys.names].sort(), ['nonHostExpando', 'otherExpando'])
})

// `stateMap[ wireframe ] = state` in three's WebGLBindingStates.js, where
// `wireframe = (material.wireframe === true)`: the key is a `===` result,
// typed `boolean` by the checker. `ToPropertyKey` of a boolean can only be
// "true" or "false" (ECMA-262 7.1.14), and `boolean` is its own native
// scalar carrier (`src/representation/primitives.ts`), so a program cannot
// smuggle a third value through a cell the compiler represents with two
// bit patterns. Naming both keys must collapse the wildcard into two named
// surface keys that do not touch `Object.prototype`.
test('a boolean-typed computed key on an opaque receiver names both keys, not the wildcard', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    declare function unknown(): any
    declare function coinFlip(): boolean
    const root: any = Math.random() ? globalThis : unknown()
    const wireframe = coinFlip()
    root[wireframe] = 1
  `
  const taint = globalHostMutationTaintOf(source)
  assert.deepEqual([...taint], [])
  assert.equal(taint.surfaceKeys.every, false)
  assert.deepEqual([...taint.surfaceKeys.names].sort(), ['false', 'true'])
})

test('a single boolean-literal-typed key names only that one key', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    declare function unknown(): any
    function write(root: any, flag: true): void {
      root[flag] = 1
    }
    write(Math.random() ? globalThis : unknown(), true)
  `
  const taint = globalHostMutationTaintOf(source)
  assert.deepEqual([...taint], [])
  assert.equal(taint.surfaceKeys.every, false)
  assert.deepEqual([...taint.surfaceKeys.names], ['true'])
})

// The negative arm this reader must never cross: a `string`-typed key --
// even narrowed to a literal union by its declared type -- is not trusted,
// because `primitiveCarrier` gives every string, literal or not, the same
// generic `{ kind: 'string' }` carrier, and TypeScript lets an `any` reach a
// `'a' | 'b'`-typed parameter with no diagnostic. Naming it here would let a
// value the compiled representation cannot bound certify as bounded to
// `{'a','b'}` -- silently missing whatever the `any` actually carried.
test('a string-literal-union-typed computed key on an opaque receiver still wildcards', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    declare function unknown(): any
    function write(root: any, key: 'a' | 'b'): void {
      root[key] = 1
    }
    write(Math.random() ? globalThis : unknown(), Math.random() > 0.5 ? 'a' : 'b')
  `
  const taint = globalHostMutationTaintOf(source)
  assert.equal(taint.surfaceKeys.every, true)
})

test('a plain string-typed computed key on an opaque receiver still wildcards', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    declare function unknown(): any
    declare function runtimeKey(): string
    const root: any = Math.random() ? globalThis : unknown()
    const key = runtimeKey()
    root[key] = 1
  `
  const taint = globalHostMutationTaintOf(source)
  assert.equal(taint.surfaceKeys.every, true)
})

for (const [name, source] of [
  [
    'a runtime-computed key',
    'declare function runtimeKey(): string; const root: any = globalThis; const key: string = runtimeKey(); root[key] = 1'
  ],
  ['an unresolved call result', `declare function unknown(): any; unknown().hostProcess = otherProcess; ${globalReachesData}`],
  [
    'Object.assign with a dynamic source',
    "const root: any = globalThis; const patch: any = {}; const key: string = 'nonHostExpando'; patch[key] = 1; Object.assign(root, patch)"
  ],
  [
    'Object.defineProperties with a dynamic source',
    "const root: any = globalThis; const descriptors: any = {}; const key: string = 'nonHostExpando'; descriptors[key] = { value: 1 }; Object.defineProperties(root, descriptors)"
  ],
  ['Object.assign with an exact host key', 'const root: any = globalThis; Object.assign(root, { hostProcess: otherProcess })']
] as const) {
  test(`${name} remains fail-closed`, () => {
    if (name === 'Object.defineProperties with a dynamic source') {
      assertWildcardHostTaint(source)
      return
    }
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          hostDeclaration,
          'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
        ],
        [entry, `${source}; const bare = hostProcess; void bare`]
      ]),
      plugins: [plugin]
    })

    assertOnlyGlobalHostMutationRefusal(result)
  })
}

for (const [name, source] of [
  [
    'shadowed Object.assign',
    `
      function run(Object: { assign(target: object, source: object): object }): void {
        Object.assign(globalThis, { nonHostExpando: 1 })
      }
      run({ assign(target: object) { return target } })
    `
  ],
  [
    'aliased shadowed Reflect.set',
    `
      function run(Reflect: { set(target: object, key: string, value: unknown): boolean }): void {
        const set = Reflect.set
        set(globalThis, 'nonHostExpando', 1)
      }
      run({ set() { return true } })
    `
  ],
  [
    'overwritten intrinsic mutator alias',
    `
      declare const unknownDefine: typeof Object.defineProperty
      let define = Object.defineProperty
      define = unknownDefine
      define(globalThis, 'nonHostExpando', { value: 1 })
    `
  ],
  [
    'ambient Object.assign patch',
    `
      declare const patch: Record<string, unknown>
      Object.assign(globalThis, patch)
    `
  ],
  [
    'unwritten parameter Object.assign patch',
    `
      function apply(patch: Record<string, unknown>): void { Object.assign(globalThis, patch) }
      void apply
    `
  ],
  [
    'Reflect.set receiver',
    `
      const target = { nonHostExpando: 0 }
      declare const key: string
      Reflect.set(target, key, 1, globalThis)
    `
  ],
  [
    'computed object field in an unknown-call escape',
    `
      declare function escape(value: unknown): void
      declare const key: string
      escape({ [key]: globalThis })
    `
  ],
  [
    'getter value in an unknown-call escape',
    `
      declare function escape(value: unknown): void
      escape({ get root() { return globalThis } })
    `
  ],
  [
    'recursively nested unknown-call escape',
    `
      declare function escape(value: unknown): void
      escape({ outer: [{ inner: globalThis }] })
    `
  ],
  [
    'opaque construction result',
    `
      declare const OpaqueConstructor: new () => any
      declare const key: string
      new OpaqueConstructor()[key] = 1
    `
  ],
  [
    'explicit method this argument',
    `
      declare const key: string
      function mutate(this: any): void { this[key] = 1 }
      mutate.call(globalThis)
    `
  ],
  [
    'rest parameter element',
    `
      declare const key: string
      function mutate(...values: any[]): void { values[0][key] = 1 }
      mutate(globalThis)
    `
  ],
  [
    'destructured parameter field',
    `
      declare const key: string
      function mutate({ root }: { root: any }): void { root[key] = 1 }
      mutate({ root: globalThis })
    `
  ],
  [
    'arguments element',
    `
      declare const key: string
      function mutate(): void { (arguments[0] as any)[key] = 1 }
      mutate(globalThis)
    `
  ],
  [
    'overwritten Object.assign intrinsic',
    `
      declare const replacement: typeof Object.assign
      Object.assign = replacement
      Object.assign(globalThis, { nonHostExpando: 1 })
    `
  ],
  [
    'overwritten Object.defineProperty intrinsic',
    `
      declare const replacement: typeof Object.defineProperty
      Object.defineProperty = replacement
      Object.defineProperty(globalThis, 'nonHostExpando', { value: 1 })
    `
  ],
  [
    'overwritten Reflect.set intrinsic',
    `
      declare const replacement: typeof Reflect.set
      Reflect.set = replacement
      Reflect.set(globalThis, 'nonHostExpando', 1)
    `
  ],
  [
    'overwritten Reflect.defineProperty intrinsic',
    `
      declare const replacement: typeof Reflect.defineProperty
      Reflect.defineProperty = replacement
      Reflect.defineProperty(globalThis, 'nonHostExpando', { value: 1 })
    `
  ],
  [
    'globalThis.Object constructor overwrite',
    `
      declare const replacement: typeof Object.assign
      globalThis.Object.assign = replacement
      Object.assign(globalThis, { nonHostExpando: 1 })
    `
  ],
  [
    'Object constructor alias overwrite',
    `
      declare const replacement: typeof Object.assign
      const O = Object
      O.assign = replacement
      Object.assign(globalThis, { nonHostExpando: 1 })
    `
  ],
  [
    'destructured Object constructor alias overwrite',
    `
      declare const replacement: typeof Object.assign
      const { Object: O } = globalThis
      O.assign = replacement
      Object.assign(globalThis, { nonHostExpando: 1 })
    `
  ],
  [
    'destructured Reflect constructor alias overwrite',
    `
      declare const replacement: typeof Reflect.set
      const { Reflect: R } = globalThis
      R.set = replacement
      Reflect.set(globalThis, 'nonHostExpando', 1)
    `
  ],
  [
    'later whole-program intrinsic overwrite',
    `
      declare const replacement: typeof Object.assign
      function write(): void { Object.assign(globalThis, { nonHostExpando: 1 }) }
      Object.assign = replacement
      write()
    `
  ]
] as const) {
  test(`${name} wildcard-taints host globals`, () => {
    const taint = globalHostMutationTaintOf(`
      interface Process {}
      declare var hostProcess: Process
      ${globalReachesData}
      ${source}
      const bare = hostProcess
      void bare
    `)
    assert.ok(taint.has('*'), [...taint].join(','))
  })
}

for (const [name, source] of [
  [
    'method this',
    `
      function mutate(this: any): void { this.hostProcess = undefined }
      mutate.call(globalThis)
    `
  ],
  [
    'rest parameter',
    `
      function mutate(...values: any[]): void { values[0].hostProcess = undefined }
      mutate(globalThis)
    `
  ],
  [
    'destructured parameter',
    `
      function mutate({ root }: { root: any }): void { root.hostProcess = undefined }
      mutate({ root: globalThis })
    `
  ],
  [
    'arguments object',
    `
      function mutate(): void { (arguments[0] as any).hostProcess = undefined }
      mutate(globalThis)
    `
  ]
] as const) {
  test(`${name} call flow taints only the exact host binding`, () => assertExactHostProcessTaint(source))
}

for (const [name, mutation] of [
  [
    'method return through this',
    'declare const key: string; const holder = { root: globalThis, getRoot() { return this.root } }; holder.getRoot()[key] = otherProcess'
  ],
  [
    'local constructor object return',
    'declare const key: string; function Root(): any { return globalThis }; new Root()[key] = otherProcess'
  ],
  [
    'array rest preserved element path',
    'declare const key: string; const values: any[] = [0, globalThis]; const [, ...tail] = values; tail[0][key] = otherProcess'
  ],
  [
    'object rest preserved property path',
    'declare const key: string; const source = { skip: 0, root: globalThis }; const { skip, ...rest } = source; rest.root[key] = otherProcess; void skip'
  ]
] as const) {
  test(`${name} retains host mutation flow`, () => {
    const taint = globalHostMutationTaintOf(`
      interface Process {}
      declare var hostProcess: Process
      declare var otherProcess: Process
      ${mutation}
      const bare = hostProcess
      void bare
    `)
    assert.deepEqual([...taint], ['*'])
  })
}

for (const [name, source] of [
  [
    'binding element default',
    `
      const { root = globalThis }: { root?: any } = {}
      root.hostProcess = undefined
    `
  ],
  [
    'destructured parameter property default',
    `
      function mutate({ root = globalThis }: { root?: any }): void { root.hostProcess = undefined }
      mutate({})
    `
  ],
  [
    'destructured parameter default on undefined',
    `
      function mutate({ root }: { root: any } = { root: globalThis }): void { root.hostProcess = undefined }
      mutate(undefined)
    `
  ]
] as const) {
  test(`${name} is an alternate global alias source`, () => assertExactHostProcessTaint(source))
}

for (const [name, source] of [
  [
    'object rest is a fresh container',
    'declare const key: string; const { ...rest } = globalThis; rest[key] = otherProcess; const bare = hostProcess; void bare'
  ],
  [
    'array rest is a fresh container',
    'declare const key: string; const [...tail] = [globalThis]; (tail as any)[key] = otherProcess; const bare = hostProcess; void bare'
  ],
  [
    'Object.assign returns its target without becoming opaque',
    'Object.assign(globalThis, { nonHostExpando: 1 }).nonHostExpando = 2; const bare = hostProcess; void bare'
  ]
] as const) {
  test(name, () => {
    assert.deepEqual(
      [
        ...globalHostMutationTaintOf(`
        interface Process {}
        declare var hostProcess: Process
        declare var otherProcess: Process
        ${source}
      `)
      ],
      []
    )
  })
}

for (const [name, source, tainted] of [
  [
    'a pure property cycle',
    'const holder: any = {}; holder.root = holder.self; holder.self = holder.root; holder.root.hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ],
  [
    'a pure call-return cycle',
    'function first(): any { return second() } function second(): any { return first() } first().hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ],
  [
    'a nested object-property storage cycle',
    'let holder: any = { container: {} }; holder = holder.container.root; holder.root.hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ],
  [
    'a nested element-property storage cycle',
    'let holder: any = []; holder = holder[0]; holder[0].hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ],
  [
    'a nested return-property storage cycle',
    'let holder: any; function first(): any { return second() } function second(): any { return first() } holder = first(); holder.root.hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ],
  [
    'a property cycle with a globalThis sibling write',
    'const holder: any = {}; holder.root = holder.self; holder.self = holder.root; holder.root = globalThis; holder.root.hostProcess = undefined; const bare = hostProcess; void bare',
    true
  ],
  [
    'a duplicate non-cyclic property DAG',
    'const shared: any = {}; const holder: any = {}; holder.root = shared; holder.root = shared; holder.root.hostProcess = undefined; const bare = hostProcess; void bare',
    false
  ]
] as const) {
  test(`global alias traversal handles ${name}`, () => {
    if (name === 'a property cycle with a globalThis sibling write') {
      assertExactHostProcessTaint(source)
      return
    }
    const result = compile({
      rootFileNames: [entry, hostDeclaration],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          hostDeclaration,
          'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
        ],
        [builtinSource, 'export const retained = true'],
        [entry, source]
      ]),
      plugins: [plugin]
    })

    if (!tainted) {
      assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
      assert.deepEqual(result.loweringBlockers, [])
      assert.deepEqual(result.emissionRefusals, [])
      return
    }
    assertOnlyGlobalHostMutationRefusal(result)
  })
}

test('global alias fixed point scales through cyclic diamonds, repeated storage reads, and an exact true branch', () => {
  const count = 1024
  const hotCount = 512
  const cycle = Array.from({ length: count }, (_, index) => `const cycle${index}: any = {};`).join('\n')
  const cycleEdges = Array.from({ length: count }, (_, index) => `cycle${index}.next = cycle${(index + 1) % count};`).join('\n')
  const diamonds = Array.from({ length: count }, (_, index) => `const diamond${index}: any = {};`).join('\n')
  const diamondEdges = Array.from({ length: count }, (_, index) => {
    if (index === 0) return 'diamond0.left = cycle0; diamond0.right = cycle1;'
    return `diamond${index}.left = diamond${index - 1}; diamond${index}.right = diamond${index - 1};`
  }).join('\n')
  const bsonDeepReads = Array.from(
    { length: count },
    (_, index) =>
      `const bsonObjectIdState${index}: any = cycle${index}.next.next.next.next; bsonObjectIdState${index}.hostProcess = undefined;`
  ).join('\n')
  const fastifyDeepReads = Array.from(
    { length: count },
    (_, index) =>
      `const fastifyHookState${index}: any = diamond${index}.left.right.left.right; fastifyHookState${index}.hostProcess = undefined;`
  ).join('\n')
  const hotValues = Array.from({ length: hotCount }, (_, index) => `const hotValue${index}: any = {};`).join('\n')
  const hotWrites = Array.from({ length: hotCount }, (_, index) => `hot.slot = hotValue${index};`).join('\n')
  const hotReads = Array.from({ length: hotCount }, (_, index) => `const hotRead${index}: any = hot.slot;`).join('\n')
  const falseOnlySource = `
    interface Process {}
    declare var hostProcess: Process
    ${cycle}
    ${cycleEdges}
    ${diamonds}
    ${diamondEdges}
    ${bsonDeepReads}
    ${fastifyDeepReads}
    const hot: any = {}
    ${hotValues}
    ${hotWrites}
    ${hotReads}
  `
  assert.deepEqual([...globalHostMutationTaintOf(falseOnlySource)], [])
  const source = `
    ${falseOnlySource}
    const seeded: any = diamond${count - 1}
    seeded.root = globalThis
    seeded.root.hostProcess = undefined
    const bare = hostProcess
    void bare
  `
  const audit = globalHostMutationAuditOf(source)
  assert.deepEqual([...audit.taint], [audit.bindings.get('hostProcess')!])
})

test('post-discovery selectors cover an aliased Object.assign global route without graph growth', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
      ],
      [
        entry,
        'const left: any = {}; const right: any = left; Object.assign(left, { root: globalThis }); right.root.hostProcess = undefined; const bare = hostProcess; void bare'
      ]
    ]),
    plugins: [plugin]
  })

  assertOnlyGlobalHostMutationRefusal(result)
})

test('post-discovery closure interns a late storage literal before selector expansion', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
      ],
      [
        entry,
        'const left: any = {}; const right: any = left; left.payload = { root: globalThis }; right.payload.root.hostProcess = undefined; const bare = hostProcess; void bare'
      ]
    ]),
    plugins: [plugin]
  })

  assertOnlyGlobalHostMutationRefusal(result)
})

test('runtime-computed global keys never acquire host provenance', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
      ],
      [builtinSource, 'export const retained = true'],
      [entry, "const key: string = 'hostProcess'; const observed = (globalThis as any)[key]; void observed"]
    ]),
    plugins: [plugin]
  })

  const optimized = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'property' && operation.resolvedGlobalBinding === true
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.deepEqual(optimized, [])
})

test('an unreachable function mutation does not invalidate reachable host projections', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
      ],
      [
        entry,
        `
          function unreachable(): void { globalThis.hostProcess = otherProcess }
          const bare = hostProcess
          const projected = globalThis.hostProcess
          void [bare, projected]
        `
      ]
    ]),
    plugins: [plugin]
  })

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
})

test('writes in a pruned class method do not enter reachable storage flow', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [hostDeclaration, 'interface Process {} declare var hostProcess: Process; declare var otherProcess: Process'],
      [
        entry,
        `
          const holder: any = {}
          class ReachableShape { poison(): void { holder.root = globalThis } }
          new ReachableShape()
          holder.root.hostProcess = undefined
          const bare = hostProcess
          void bare
        `
      ]
    ]),
    plugins: [plugin]
  })

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
})

test('a mutation-only runtime-key path remains a valid dynamic operation', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [hostDeclaration, 'interface Process {} declare var hostProcess: Process; declare var otherProcess: Process'],
      [entry, "const key: string = 'hostProcess'; (globalThis as any)[key] = 1"]
    ]),
    plugins: [plugin]
  })

  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source ?? '', /setProperty|write/)
})

// `runtime/host.ts` exports every host global through the same guard --
// `typeof __gea_audioContext !== 'undefined' ? __gea_audioContext : (undefined
// as unknown as AudioContext)` -- so a bare top-level reference cannot
// ReferenceError in a runtime that never injected it. The value is one arm or
// the other: the ambient host object, or `undefined`. Neither is the global
// object, and a member operation on `undefined` throws before it could reach
// any host binding. The conditional therefore publishes what its arms agree
// on once the nullish arm is set aside, and the ambient `declare const` in an
// ordinary `.ts` file is the same host-supplied cell as one in a `.d.ts`.
// Before this, `audioContext.createOscillator()` was an opaque call result,
// `oscillator.type = 'square'` an opaque assignment receiver, and every host
// binding in the program was refused as possibly mutated.
test('a typeof-guarded ambient host value published through a conditional keeps its native receiver', () => {
  const audit = globalHostMutationAuditOf(
    `
      export {}
      interface Process {}
      declare var hostProcess: Process
      interface OscillatorNode { type: string; start(when: number): void }
      interface AudioContext { createOscillator(): OscillatorNode }
      declare const __host_audio: AudioContext
      const audio: AudioContext = typeof __host_audio !== 'undefined' ? __host_audio : (undefined as unknown as AudioContext)
      const oscillator = audio.createOscillator()
      oscillator.type = 'square'
      oscillator.start(0)
    `,
    ['hostProcess'],
    ['AudioContext', 'OscillatorNode']
  )
  assert.deepEqual([...audit.taint], [])
})

test('a conditional whose other arm is a real object publishes nothing, and its method receiver stays opaque', () => {
  const audit = globalHostMutationAuditOf(
    `
      export {}
      interface Process {}
      declare var hostProcess: Process
      interface OscillatorNode { type: string }
      interface AudioContext { createOscillator(): OscillatorNode }
      declare const __host_audio: AudioContext
      const maybe: AudioContext = typeof __host_audio !== 'undefined' ? __host_audio : ({} as AudioContext)
      maybe.createOscillator().type = 'square'
    ${globalReachesData}
    `,
    ['hostProcess'],
    ['AudioContext', 'OscillatorNode']
  )
  // Opaque: its exact key is recorded on every surface.
  assert.ok(audit.taint.surfaceKeys.every || audit.taint.surfaceKeys.names.has('type'), [...audit.taint].join(','))
})

// `mount<RootComponent extends Component>(component: new () => RootComponent)`
// constructs `new component()` and calls `render` on it. A type parameter has
// no identity of its own -- the value is whatever its constraint admits -- so
// the receiver's provenance is the constraint's, a source class. Lumping
// `TypeParameter` in with `any` made the instance opaque and one
// `instance.render()` a wildcard over every host binding.
test('a type parameter publishes its constraint, so a constructed source-class instance is not opaque', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    interface Process {}
    declare var hostProcess: Process
    class Component { render(): void {} }
    class App extends Component {}
    function mount<RootComponent extends Component>(component: new () => RootComponent): void {
      const instance = new component()
      ;(instance as unknown as { render(): void }).render()
    }
    mount(App)
  `)
  assert.deepEqual([...audit.taint], [])
})

test('an unconstrained type parameter still proves nothing about a constructed value', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    interface Process {}
    declare var hostProcess: Process
    class App {}
    function mountAny<T>(component: new () => T): void {
      const instance = new component()
      ;(instance as any).hostProcess = 1
    }
    mountAny(App)
  ${globalReachesData}
  `)
  assert.ok(audit.taint.has('*') || audit.taint.has(audit.bindings.get('hostProcess')!), [...audit.taint].join(','))
})

// An import binding is an alias, not a cell: it binds live to the exporting
// module's declaration, and the flow index files that declaration's
// initializer write there. A census that stopped at the `ImportSpecifier`
// saw a name with no writes and no ambience, so every host object an app
// reached through a package import lost its representation at the import.
test('a host value imported from another module keeps the representation its declaration publishes', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process'
      ],
      [
        builtinSource,
        "export const proc: Process = typeof otherProcess !== 'undefined' ? otherProcess : (undefined as unknown as Process)"
      ],
      [
        entry,
        "import { proc } from './global-this-host-builtin.js'; const mod = proc.getBuiltinModule('known'); void mod; const bare = hostProcess; void bare"
      ]
    ]),
    plugins: [plugin]
  })
  const roots = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  assert.ok(
    roots.every((diagnostic) => !/authenticated host global may be mutated through globalThis/.test(diagnostic.message)),
    JSON.stringify(roots)
  )
})

// The framework's re-export of a host NAMESPACE goes through the same guard,
// and each arm is converted into the merge's carrier before it reaches the
// phi. A path does not change by being viewed under another carrier, and
// neither does absence: the convert has to carry both, or the merge is minted
// as a variable and its predecessor write asks `operandText` for a value the
// namespace never had.
test('a typeof-guarded host namespace re-export is still a path after its arms are converted', () => {
  const result = compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        hostDeclaration,
        'interface Process { getBuiltinModule(id: string): any } declare var hostProcess: Process; declare var otherProcess: Process; interface HostBufferConstructor { from(value: string): any } declare var HostBuffer: HostBufferConstructor'
      ],
      [builtinSource, 'export const retained = true'],
      [
        entry,
        "export const Buf = typeof HostBuffer !== 'undefined' ? HostBuffer : (undefined as unknown as typeof HostBuffer); const buffer = Buf.from('x'); void buffer"
      ]
    ]),
    plugins: [plugin]
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.match(result.source ?? '', /test::buffer_from/)
})

test('fresh literal identity prevents structural native-interface matches from poisoning intrinsic trust', () => {
  for (const initializer of ['{}', 'true ? {} : {}']) {
    const audit = globalHostMutationAuditOf(
      `
      interface Process {}
      declare var hostProcess: Process
      declare const key: string
      const fresh = ${initializer}
      const cache = fresh
      cache[key] = 1
      const bytes = new Uint8Array(4)
      ;(bytes.subarray(0) as any).hostProcess = undefined
    `,
      ['hostProcess'],
      ['Uint8Array']
    )
    assert.deepEqual([...audit.taint], [])
  }
  const unknown = globalHostMutationAuditOf(
    `
    interface Process {}
    declare var hostProcess: Process
    declare const key: string
    const cache: {} = new Uint8Array(4)
    cache[key] = 1
    const bytes = new Uint8Array(4)
    ;(bytes.subarray(0) as any).hostProcess = undefined
  ${globalReachesData}
  `,
    ['hostProcess'],
    ['Uint8Array']
  )
  assert.ok(unknown.taint.has('*'), 'an actual native allocation must retain mutation taint despite its empty structural annotation')
})

test('computed intrinsic writes taint only method names admitted by the key domain', () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["index + '_' + indexArray", false],
    ['`${index}_${indexArray}`', false],
    ["'sli' + suffix", false],
    ["'sub' + suffix", true],
    ["flag ? 'subarray' : `${index}_${indexArray}`", true],
    ["'__' + suffix", true],
    ["opaque as 'cache'", true],
    ['suffix', true]
  ]
  for (const [key, wildcard] of cases) {
    const audit = globalHostMutationAuditOf(
      `
      interface Process {}
      declare var hostProcess: Process
      let index = 1, indexArray = 2
      declare const suffix: string, opaque: unknown, flag: boolean
      const bytes = new Uint8Array(4)
      const key = ${key}
      const alias = key
      ;(bytes as unknown as Record<string, unknown>)[alias] = () => globalThis
      ;(bytes.subarray(0) as any).hostProcess = undefined
    `,
      ['hostProcess'],
      ['Uint8Array']
    )
    // An untrusted `subarray` result may be the global object: its exact
    // `hostProcess` write replaces that binding.
    assert.equal(audit.taint.has('*') || audit.taint.has(audit.bindings.get('hostProcess')!), wildcard, key)
    if (!wildcard) assert.deepEqual([...audit.taint], [], key)
  }
})

test('virtual override return origins reach mutations through the shared target relation', () => {
  const audit = globalHostMutationAuditOf(
    `
    export {}
    declare var hostProcess: object
    class Root { value(): object { return {} } }
    class Middle extends Root { value(): object { return {} } }
    class Leaf extends Middle { value(): object { return globalThis } }
    const receiver: Root = new Leaf()
    ;(receiver.value() as { hostProcess: object }).hostProcess = {}
  `,
    ['hostProcess'],
    [],
    undefined,
    true
  )
  assert.ok(audit.taint.has(audit.bindings.get('hostProcess')!), 'every overriding body contributes its actual returned identity')
})

test('an explicit receiver declaration does not consume a runtime argument slot', () => {
  const audit = globalHostMutationAuditOf(
    `
    export {}
    declare var hostProcess: object
    function write(this: object, value: { hostProcess: object }): void { value.hostProcess = {} }
    write.call({}, globalThis)
  `,
    ['hostProcess'],
    [],
    undefined,
    true
  )
  assert.ok(audit.taint.has(audit.bindings.get('hostProcess')!))
  assert.ok(!audit.taint.has('*'), 'the concrete global argument must not become an unknown frame')
})

test('a module-scoped inert host binding is not a same-spelled global property', () => {
  const source = `
    declare var hostProcess: object
    declare const opaque: unknown
    /** @gea-host-inert */
    declare function sink(value: unknown): void
    ;(opaque as { sink: unknown }).sink = 0
    sink(opaque)
  `
  const lexical = globalHostMutationAuditOf('export {};\n' + source)
  assert.ok(!lexical.taint.has('*'), 'global property mutation cannot replace a module lexical binding')
  assert.ok(!lexical.taint.has(lexical.bindings.get('hostProcess')!))
  const global = globalHostMutationAuditOf(`${source}
${globalReachesData}`)
  assert.ok(global.taint.has('*'), 'the same mutation can replace an ambient global function')
})

test('derived construction retains alternate object returns from its inherited constructor', () => {
  for (const body of ['', 'constructor() { super() }']) {
    const audit = globalHostMutationAuditOf(`
      export {};
      declare var hostProcess: object;
      declare const key: string;
      class Root { constructor() { return globalThis } }
      class Child extends Root { ${body} }
      const instance = new Child();
      instance[key] = {};
    `)
    assert.ok(audit.taint.has('*'), `base constructor can return the global object: ${body}`)
  }
})

test('source subclass construction retains uncertainty from an external base', () => {
  for (const body of ['', 'constructor() { super() }', 'constructor() { super(); return this }']) {
    const audit = globalHostMutationAuditOf(`
      export {};
      declare var hostProcess: object;
      declare const key: string;
      declare const External: new () => object;
      class Child extends External { ${body} }
      const instance = new Child();
      instance[key] = {};
    ${globalReachesData}
    `)
    assert.ok(audit.taint.has('*'), `an external base can replace the constructed receiver: ${body}`)
  }
})

test('imported source callable origins preserve body effects through live export bindings', () => {
  const source = `import { invoke } from './global-host-import-source.js';
    declare var hostProcess: object;
    invoke([]);`
  const audit = (moduleSource: string) =>
    globalHostMutationAuditOf(
      source,
      ['hostProcess'],
      [],
      undefined,
      true,
      new Map([[resolve('test/fixtures/global-host-import-source.ts'), moduleSource]])
    ).taint
  assert.deepEqual([...audit('export function invoke(value: unknown) {}')], [])
  assert.deepEqual([...audit('export const invoke = (value: unknown) => {};')], [])
  assert.deepEqual(
    [
      ...audit(`export let invoke = (value: unknown) => {};
    invoke = (value: unknown) => { return value; };`)
    ],
    []
  )
  assert.ok(
    audit(`export function invoke(value: unknown) {
    Object.prototype.changed = true;
  }`).size > 0
  )
  assert.ok(
    audit(`declare const external: (value: unknown) => void;
    export let invoke = (value: unknown) => {}; invoke = external;`).size > 0
  )
})

test('settled numeric key parameters preserve intrinsic trust through a forwarded indexed write', () => {
  const source = `
    interface Process {}
    declare var hostProcess: Process
    const bytes = new Uint8Array(4)
    function write(index) { bytes[index] = 65 }
    function forward(index) { write(index) }
    forward(0)
    ;(bytes.subarray(0) as any).hostProcess = undefined
    ${globalReachesDataQuietly}
  `
  assert.ok(
    globalHostMutationAuditOf(
      `${source}
${globalReachesData}`,
      ['hostProcess'],
      ['Uint8Array']
    ).taint.has('*')
  )
  assert.deepEqual([...globalHostMutationAuditOf(source, ['hostProcess'], ['Uint8Array'], undefined, true).taint], [])
  for (const variant of [
    source.replace('forward(0)', 'forward("subarray")'),
    source.replace('forward(0)', 'declare const opaqueKey: any; forward(opaqueKey)')
  ])
    assert.ok(
      globalHostMutationAuditOf(
        `${variant}
${globalReachesData}`,
        ['hostProcess'],
        ['Uint8Array'],
        undefined,
        true
      ).taint.has('*')
    )
})

test('a method call on an unmodelled-frame source-class result is not a global-object candidate', () => {
  // Mirrors the three.js app's `this.coplanarPoint( _vector1 ).applyMatrix4( matrix )`:
  // `coplanarPoint`'s call-frame (how its argument forwards into the callee's
  // body) is a shape `closedCallableAuthorityOf` does not model -- the class'
  // exported instance is what makes the receiver family unenumerable, the
  // same "open; deliberate" boundary `SEMANTIC-AUTHORITY.md` item D names --
  // so the call is a "refused source invocation". Its declared/inferred
  // result type is still an ordinary source class, `Vector3`, never
  // `globalThis`, and the unmodelled frame must not make
  // `.applyMatrix4(...)`'s receiver opaque on that account.
  const source = `
    declare var hostProcess: object
    class Vector3 {
      x = 0
      copy(v: Vector3): Vector3 { this.x = v.x; return this }
      applyMatrix4(_m: number): Vector3 { return this }
    }
    class Plane {
      normal = new Vector3()
      coplanarPoint(target: Vector3): Vector3 { return target.copy(this.normal) }
      distanceToPoint(matrix: number): Vector3 {
        const _vector1 = new Vector3()
        return this.coplanarPoint(_vector1).applyMatrix4(matrix)
      }
    }
    export const plane = new Plane()
    plane.distanceToPoint(1)
  `
  // Vector3's own `x` field write still taints its own binding -- ordinary,
  // unrelated bookkeeping -- but the unmodelled frame must not cost the
  // program its wildcard.
  assert.equal(globalHostMutationAuditOf(source, ['hostProcess'], [], undefined, true).taint.has('*'), false)
})

test('a super() call forwards its arguments into the base constructor like new Base() does', () => {
  // three's `class DirectionalLight extends Light { constructor( color, intensity ) { super( color, intensity ) } }`:
  // the base body is program code selected by the heritage clause, so an
  // opaque argument reaching it is no more a mutation of the host than the
  // same argument at `new Light( ... )` is -- which the census never asks about.
  const classes = `
    declare function opaque(): any;
    class Light { color: unknown; intensity: number; constructor(color: unknown, intensity = 1) { this.color = color; this.intensity = intensity } }
    class Directional extends Light { constructor(color: unknown, intensity: number) { super(color, intensity) } }
  `
  const source = `export {}; declare var hostProcess: object; ${classes} new Directional(1, opaque());`
  assert.equal(globalHostMutationTaintOf(source).has('*'), false, source)
  // A base whose binding the program rewrites selects no single constructor: the wildcard stands.
  const rewritten = `export {}; declare var hostProcess: object; ${classes} Light = opaque(); new Directional(1, opaque()); ${globalReachesData}`
  assert.equal(globalHostMutationTaintOf(rewritten).has('*'), true, rewritten)
})

test('a call through a member slot that only ever holds null runs nothing and authenticates no callee', () => {
  // three's `Texture`: `this.onUpdate = null`, guarded `if ( texture.onUpdate ) texture.onUpdate( texture )`.
  const texture = 'class Texture { onUpdate: ((texture: Texture) => void) | null = null; version = 0 }'
  const upload = 'function upload(texture: Texture) { if (texture.onUpdate) texture.onUpdate(opaque()) }'
  const source = `export {}; declare var hostProcess: object; declare function opaque(): any; ${texture} ${upload} upload(new Texture());`
  assert.equal(globalHostMutationTaintOf(source).has('*'), false, source)
  // A store of an opaque value into the slot makes it callable again: the wildcard stands.
  const stored = `${source} const held = new Texture(); held.onUpdate = opaque(); upload(held); ${globalReachesData}`
  assert.equal(globalHostMutationTaintOf(stored).has('*'), true, stored)
})

test('a `new` whose constructor is compiled here allocates a fresh object, not a possible global', () => {
  // three's instances -- `new Vector3()`, `new Scene()` -- are allocations
  // this program made. Whether the representation layer could PLACE the class
  // is a separate question from whether the value could be `globalThis`, and
  // seeding the construction opaque answered the second with the first: every
  // unrepresented instance became a value that might be the global object, so
  // every key written through one tainted the intrinsic surface.
  const allocation = 'class Holder { value = 1; constructor() {} }'
  const source = `export {}; declare var hostProcess: object; declare function unknown(value: unknown): void; ${allocation} unknown(new Holder());`
  assert.equal(globalHostMutationTaintOf(source).has('*'), false, source)
  // A constructor that RETURNS the global really does evaluate to it, and the
  // completion values are what say so -- the wildcard stands.
  const escaping = `export {}; declare var hostProcess: object; declare function unknown(value: unknown): void;
    class Escaper { constructor() { return globalThis as unknown as Escaper } }
    unknown(new Escaper());`
  assert.equal(globalHostMutationTaintOf(escaping).has('*'), true, escaping)
})

test('a static field written on the class does not replace the class or its methods', () => {
  // three's `Object3D.DEFAULT_UP = new Vector3( 0, 1, 0 )` is a static field,
  // not a rebinding of `Object3D`. Counting it as a write that could put a
  // different callable in the path made every `this.scene.add( ... )`,
  // `pilot.add( ... )` and `super.copy( ... )` in the program file a wildcard.
  const declarations = 'declare function opaque(): any; class Holder { static DEFAULT = 1; add(value: unknown) {} }'
  const source = `export {}; declare var hostProcess: object; ${declarations}
    Holder.DEFAULT = 2
    new Holder().add(globalThis);`
  assert.equal(globalHostMutationTaintOf(source).has('*'), false, source)
  // Rebinding the class itself really does replace the body this call reaches.
  const rebound = `export {}; declare var hostProcess: object; declare function opaque(): any
    let Holder = class { add(value: unknown) {} }
    const holder = new Holder()
    Holder = opaque()
    holder.add(globalThis);`
  assert.equal(globalHostMutationTaintOf(rebound).has('*'), true, rebound)
})

// `taintReceiverKeys`'s `facts.opaque`/`facts.global` are a per-COMPONENT
// union: a pooled array slot that has ever held BOTH a fresh, well-typed
// allocation and `globalThis` (through some other push this exact read never
// sees) carries both terms on every read, regardless of which element a
// given read actually names. Every caller already gates entry on
// `mayAliasGlobal` (`facts.global || (facts.opaque && published === null)`),
// so when `facts.global` is independently true the gate passes on that
// disjunct alone, and the surface write below used to fire from
// `facts.opaque` unconditionally -- ignoring a `publishedRepresentationOf`
// proof, the SAME per-expression proof `mayAliasGlobal` itself trusts, that
// this exact receiver's declared element type is a real source class.
test('a receiver merged with a proven global path is not a surface write when its own representation is proven', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function external(): any
    class Widget { k = 0 }
    const bag: Widget[] = []
    bag.push(new Widget())
    bag.push(globalThis as unknown as Widget)
    bag.push(external())
    function pick(i: number): Widget { return bag[i] }
    const w = pick(0)
    w.k = 1
  `)
  assert.equal(audit.taint.surfaceKeys.every, false)
  assert.ok(!audit.taint.surfaceKeys.names.has('k'), [...audit.taint.surfaceKeys.names].join(','))
})

// The negative pair to the test above: the same shape, but `bag`'s declared
// element type is `unknown`, so nothing lets `w`'s own read earn a
// `publishedRepresentationOf` proof (a bare `as Widget` cast on an operand
// the checker cannot type does not manufacture one -- `bag[i]` is still
// `unknown` at the read `pick` returns). The receiver stays genuinely
// unplaceable, and the write must still taint the surface.
test('a receiver merged with a proven global path still surface-taints without a representation proof', () => {
  const audit = globalHostMutationAuditOf(`
    export {}
    declare var hostProcess: object
    declare function external(): any
    class Widget { k = 0 }
    const bag: unknown[] = []
    bag.push(new Widget())
    bag.push(globalThis)
    bag.push(external())
    function pick(i: number): Widget { return bag[i] as Widget }
    const w = pick(0)
    w.k = 1
  `)
  assert.ok(audit.taint.surfaceKeys.every || audit.taint.surfaceKeys.names.has('k'), [...audit.taint.surfaceKeys.names].join(','))
})
