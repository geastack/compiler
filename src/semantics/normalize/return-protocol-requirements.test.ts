import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { wholeProgram } from './reachability.js'
import { censusReturnBindings } from './return-bindings.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements
} from './deferred-intrinsic-protocols.js'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'

const makeProgram = (extra = '', body = 'return context[value]') => {
  const fileName = '/return-protocol-requirements.ts'
  const source = `class Context { readonly TEXTURE_2D = 3553 } function convert(context: Context, value: number) { ${body} } const context = new Context(); convert(context, 1); ${extra}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(fileName)
      ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS)
      : original(name, version, ...rest)
  const program = ts.createProgram([fileName], options, host)
  const file = program.getSourceFile(fileName)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  return { program, checker, file, flow }
}

test('accepted return inference retains numeric absence requirements for later replay', () => {
  const { checker, file, flow } = makeProgram()
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const returns = censusReturnBindings(checker, [file], wholeProgram, emptyParameterBindingCensus, undefined, flow)
  assert.equal(returns.boundCount, 1)
  assert.ok(ledger.requirements().some((requirement) => requirement.intrinsic === 'Object' && requirement.prototypeKeys?.numeric === true))
})

test('return census scope replacement drops requirements from a withdrawn declaration', () => {
  const first = makeProgram()
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(first.flow, ledger)
  censusReturnBindings(first.checker, [first.file], wholeProgram, emptyParameterBindingCensus, undefined, first.flow)
  assert.ok(ledger.requirements().length > 0)
  const withdrawn = censusReturnBindings(first.checker, [], wholeProgram, emptyParameterBindingCensus, undefined, first.flow)
  assert.equal(withdrawn.boundCount, 0)
  assert.equal(ledger.requirements().length, 0)
})

test('accepted synthesized return unions retain numeric absence obligations', () => {
  const { checker, file, flow } = makeProgram('', 'if (value > 1) return "text"; if (value) return context[value]; return 1;')
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  for (let round = 0; round < 2; round++) {
    const returns = censusReturnBindings(checker, [file], wholeProgram, emptyParameterBindingCensus, undefined, flow)
    const declaration = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node))!
    assert.ok(returns.unionArmsAt(declaration))
    assert.ok(ledger.requirements().some((requirement) => requirement.prototypeKeys?.numeric === true))
  }
})

test('accepted numeric absence returns fail final validation after opaque instance publication', () => {
  const { program, checker, file, flow } = makeProgram('declare function opaque(value: unknown): void; opaque(context);')
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const returns = censusReturnBindings(checker, [file], wholeProgram, emptyParameterBindingCensus, undefined, flow)
  assert.equal(returns.boundCount, 1)
  assert.ok(ledger.requirements().some((requirement) => requirement.prototypeKeys?.numeric === true))
  const identities = createIdentityTable(program, checker)
  const globalHostMutationTaint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(),
    flow,
    wholeProgram,
    new Set(),
    new Set(),
    new Set(),
    undefined,
    program.getSourceFiles().filter((candidate) => candidate.isDeclarationFile)
  )
  const failed = failedIntrinsicProtocolRequirements(
    {
      checker,
      identities,
      globalHostMutationTaint,
      isStandardLibraryDeclaration: (declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    },
    ledger.requirements()
  )
  assert.ok(failed.some((requirement) => requirement.prototypeKeys?.numeric === true))
})

test('contextual return conventions discard narrower body inference requirements', () => {
  const { checker, file, flow } = makeProgram(
    'const contextual: (context: Context, value: number) => string | undefined = (context, value) => context[value];'
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const statement = file.statements.find(
    (node) => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText() === 'contextual'
  )!
  assert.ok(ts.isVariableStatement(statement))
  const declaration = statement.declarationList.declarations[0]!.initializer!
  // Limit the census to the contextual function while preserving the actual
  // program/checker/flow that establish its Context allocation family.
  const contextualFile = ts.factory.updateSourceFile(file, [statement])
  const returns = censusReturnBindings(checker, [contextualFile], wholeProgram, emptyParameterBindingCensus, undefined, flow)
  const returned = returns.typeAt(declaration)
  assert.ok(returned)
  assert.equal(checker.typeToString(returned), 'string | undefined')
  assert.deepEqual(ledger.requirements(), [])
})
