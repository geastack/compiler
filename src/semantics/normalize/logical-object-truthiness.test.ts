import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { logicalLeftObjectTruthyAt } from './logical-object-truthiness.js'
import { attachClosedScriptScope } from './flow/targets.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements
} from './deferred-intrinsic-protocols.js'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import { argumentsObjectUsesAt } from './arguments-objects.js'

const proves = (
  text: string,
  options: { readonly script?: boolean; readonly closed?: boolean; readonly checkCallers?: boolean; readonly negation?: boolean } = {}
): boolean => {
  const entry = resolve('test/runtime/logical-object-truthiness-input.ts')
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(compilerOptions),
    original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry
      ? ts.createSourceFile(name, `${options.script ? '' : 'export {};\n'}${text}`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], compilerOptions, host),
    checker = program.getTypeChecker(),
    file = program.getSourceFile(entry)!
  assert.equal(program.getSemanticDiagnostics(file).length, 0)
  let left: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (options.negation) {
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) left = node.operand
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) left = node.left
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(left)
  const flow = indexValueFlow(checker, [file], wholeProgram)
  if (options.closed) attachClosedScriptScope(flow, { files: new Set([file]) })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const proof = ledger.capture(() => logicalLeftObjectTruthyAt(checker, flow, left!))
  if (options.checkCallers) {
    const owner = file.statements.find(
      (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'gap'
    )!
    const callers = closedCallableAuthorityOf(
      checker,
      flow,
      (expression) => checker.getTypeAtLocation(expression),
      (body) => argumentsObjectUsesAt(checker, body)
    )
    const callerProof = ledger.capture(() => callers.closedCallerSitesOf(owner))
    assert.ok(callerProof.value !== null, 'the same source caller authority must close the entered frames')
    assert.ok(
      callerProof.requirements.some((requirement) => requirement.sourceGlobalBinding === owner),
      'caller closure must retain exact global-binding integrity'
    )
    assert.ok(
      proof.requirements.some((requirement) => requirement.sourceGlobalBinding === owner),
      'source-value closure must retain the same integrity obligation'
    )
  }
  if (!proof.value || proof.requirements.length === 0) return proof.value
  const identities = createIdentityTable(program, checker)
  const globalHostMutationTaint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(),
    flow
  )
  return (
    failedIntrinsicProtocolRequirements(
      {
        checker,
        identities,
        globalHostMutationTaint,
        isStandardLibraryDeclaration: (declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      },
      proof.requirements
    ).length === 0
  )
}
test('a complete actual ordinary parameter family proves object presence', () => {
  assert.equal(
    proves(`interface Sibling {id: number}; function gap(previous: Sibling) {return previous && 4}; gap({id: 2}); gap({id: 1})`),
    true
  )
})
test('a Script formal requires both complete realm and sealed exact global binding integrity', () => {
  const source = `interface Sibling {id: number}; function gap(previous: Sibling) {return previous && 4}; gap({id: 2})`
  assert.equal(proves(source, { script: true }), false)
  assert.equal(proves(source, { script: true, closed: true, checkCallers: true }), true)
})
test('Script property mutation and callable or realm exposure cannot borrow the lexical boundary', () => {
  const prefix = `interface Sibling {id: number}; function gap(previous: Sibling) {return previous && 4}; gap({id: 2});`
  for (const mutation of [
    `globalThis.gap = () => 0;`,
    `delete (globalThis as any).gap;`,
    `declare function inspect(value: unknown): void; inspect(gap);`,
    `declare function inspect(value: unknown): void; inspect(globalThis);`
  ])
    assert.equal(proves(`${prefix}${mutation}`, { script: true, closed: true }), false, mutation)
})
test('closed Script frames keep omitted and explicit undefined entries', () => {
  assert.equal(
    proves(`interface Sibling {id: number}; function gap(previous?: Sibling) {return previous && 4}; gap({id: 2}); gap()`, {
      script: true,
      closed: true
    }),
    false
  )
  assert.equal(
    proves(`interface Sibling {id: number}; function gap(this: Sibling) {return this && 4}; gap.call(undefined as unknown as Sibling)`, {
      script: true,
      closed: true
    }),
    false
  )
})
test('optional and unknown entries cannot be declared present', () => {
  assert.equal(
    proves(`interface Sibling {id: number}; function gap(previous?: Sibling) {return previous && 4}; gap({id: 2}); gap()`),
    false
  )
  assert.equal(proves(`interface Sibling {id: number}; export function gap(previous: Sibling) {return previous && 4}`), false)
})
test('false casts and strict unbound receiver states preserve their real falsy values', () => {
  assert.equal(
    proves(`interface Sibling {id: number}; function gap(previous: Sibling) {return previous && 4}; gap(0 as unknown as Sibling)`),
    false
  )
  assert.equal(
    proves(`interface Sibling {id: number}; function gap(this: Sibling) {return this && 4}; gap.call(undefined as unknown as Sibling)`),
    false
  )
})

test('an object-only incoming family and its object fallback prove the exact negation operand', () => {
  assert.equal(proves(`function gap(previous: any) { if (!previous) previous = {}; return 4 }; gap({id: 2})`, { negation: true }), true)
  for (const source of [
    `function gap(previous: any) { if (!previous) previous = {}; return 4 }; gap(undefined)`,
    `function gap(previous: any) { if (!previous) previous = {}; return 4 }; gap({id: 2}); gap(0)`,
    `function gap(previous?: {id: number}) { if (!previous) previous = {id: 1}; return 4 }; gap()`,
    `declare const opaque: any; function gap(previous: any) { if (!previous) previous = {}; return 4 }; gap(opaque)`,
    `function gap(previous: {id: number}) { if (!previous) previous = {id: 1}; return 4 }; gap(0 as unknown as {id: number})`,
    `export function gap(previous: any) { if (!previous) previous = {}; return 4 }`
  ])
    assert.equal(proves(source, { negation: true }), false, source)
})
