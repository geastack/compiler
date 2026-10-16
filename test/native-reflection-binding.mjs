// Built-compiler installed native carrier contract probe, not a CLI certificate or executable.
// Run with the actual Core package graph; never synthesize a native interface.
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { createIdentityTable } from '../dist/semantics/normalize/identities.js'
import { censusGlobalHostMutations } from '../dist/semantics/normalize/global-host-mutations.js'
import { censusUnresolvableNames } from '../dist/semantics/normalize/unresolvable-names.js'
import { wholeProgram } from '../dist/semantics/normalize/reachability.js'
import { indexValueFlow } from '../dist/semantics/normalize/flow/value-flow.js'
import { attachStatedModuleSet } from '../dist/semantics/normalize/flow/targets.js'
import { createDeferredIntrinsicProtocolLedger, failedIntrinsicProtocolRequirements } from '../dist/semantics/normalize/deferred-intrinsic-protocols.js'

assert.ok(process.env.GEA_CORE_ROOT, 'GEA_CORE_ROOT must name the actual Core source graph')
const core = resolve(process.env.GEA_CORE_ROOT)
const { geaHostShims } = await import(pathToFileURL(join(core, 'packages/geatsc-plugin-gea/dist/host-shims.js')).href)
assert.equal(geaHostShims.nativeTypes.Element, 'gea::embedded::ui::NodeHandle')
const index = join(core, 'packages/core/index.d.ts')
const entry = resolve('test/fixtures/native-reflection-binding.ts')
function intact(body) {
  const source = `import type {Element} from ${JSON.stringify(index)};\n${body}`
  const options = {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: []}
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host), checker = program.getTypeChecker(), file = program.getSourceFile(entry)
  assert.equal(program.getSemanticDiagnostics(file).length, 0)
  const imported = file.statements[0].importClause.namedBindings.elements[0].name
  const element = checker.getAliasedSymbol(checker.getSymbolAtLocation(imported))
  assert.ok(element.declarations.some(declaration => resolve(declaration.getSourceFile().fileName) === resolve(index)))
  const files = program.getSourceFiles(), flow = indexValueFlow(checker, files, wholeProgram)
  attachStatedModuleSet(flow, {files, entries: [file], reachable: wholeProgram})
  const identities = createIdentityTable(program, checker)
  const taint = censusGlobalHostMutations(checker, identities, [file], censusUnresolvableNames(checker, [file]), new Set(), flow, wholeProgram, new Set(), new Set([element]))
  const ledger = createDeferredIntrinsicProtocolLedger(), proof = ledger.capture(() => ledger.requireStandardGlobalBinding('Proxy', file))
  return failedIntrinsicProtocolRequirements({checker, identities, globalHostMutationTaint: taint, isStandardLibraryDeclaration: one => program.isSourceFileDefaultLibrary(one.getSourceFile())}, proof.requirements).length === 0
}
assert.equal(intact('declare const target: Element; Reflect.set(target, "Proxy", 1)'), true)
assert.equal(intact('declare const target: any; Reflect.set(target, "Proxy", 1)'), false)
assert.equal(intact('Reflect.set(globalThis as unknown as Element, "Proxy", 1)'), false)
assert.equal(intact('const target = {}; Reflect.set(target, "Proxy", 1)'), true)
console.log('PASS installed Core Element/NodeHandle identity exclusion; any/global assertion refused; ordinary allocation preserved')
