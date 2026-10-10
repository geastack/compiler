import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import {
  ordinaryCallableBuiltinDataWriteOf,
  ordinaryCallableDataWriteIsAbsent,
  ordinaryCallableProgramSymbolDataWriteIsAbsent,
  programSymbolOriginOf,
  ordinaryFunctionDataWriteIsUnintercepted
} from './callable-data-write.js'

const contextOf = (setup = '', expression = 'target') => {
  const entry = resolve('test/runtime/callable-data-write-input.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry
      ? ts.createSourceFile(name, `${setup}\nfunction target() {}\n${expression};`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  assert.equal(program.getSemanticDiagnostics(file).length, 0, 'the prototype fixture must typecheck')
  const identities = createIdentityTable(program, checker)
  const globalHostMutationTaint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(),
    indexValueFlow(checker, [file], wholeProgram)
  )
  const location = (file.statements.at(-1) as ts.ExpressionStatement).expression
  return {
    location,
    context: {
      checker,
      identities,
      globalHostMutationTaint,
      isStandardLibraryDeclaration: (declaration: ts.Declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    }
  }
}

test('stock callable builtin data is distinct from a private constructor key absence proof', () => {
  const { context, location } = contextOf()
  for (const key of ['call', 'apply', 'bind']) {
    assert.equal(ordinaryCallableBuiltinDataWriteOf(key, location, context), key)
    assert.equal(ordinaryFunctionDataWriteIsUnintercepted(context.checker.getTypeAtLocation(location), key, location, context), false)
  }
  for (const key of ['length', 'prototype', 'caller', 'toString', 'privateKey'])
    assert.equal(ordinaryCallableBuiltinDataWriteOf(key, location, context), null, key)
  assert.equal(ordinaryCallableDataWriteIsAbsent('label', location, context), true)
  for (const key of ['call', 'apply', 'bind', 'name', 'length', 'prototype', '__proto__'])
    assert.equal(ordinaryCallableDataWriteIsAbsent(key, location, context), false, key)
})

test('readonly, replaced and accessor prototype descriptors revoke inherited writable data', () => {
  const { context, location } = contextOf(`
    Object.defineProperty(Function.prototype, 'call', {value() {}, writable: false})
    const prototypeAlias = Function.prototype
    prototypeAlias.apply = (value: any) => value
    Object.defineProperty(Object.prototype, 'bind', {set(value: unknown) {void value}})
  `)
  for (const key of ['call', 'apply', 'bind']) assert.equal(ordinaryCallableBuiltinDataWriteOf(key, location, context), null, key)
})

test('unknown prototype mutations and shadowed constructors cannot lend the standard descriptor', () => {
  const { context, location } = contextOf(`
    const prototypeAlias = Function.prototype
    declare const runtimeKey: string
    ;(prototypeAlias as any)[runtimeKey] = () => {}
  `)
  for (const key of ['call', 'apply', 'bind']) assert.equal(ordinaryCallableBuiltinDataWriteOf(key, location, context), null, key)
  const shadowed = contextOf(`
    function inspect(Function: {prototype: object}) {
      Function;
    }
  `)
  const file = shadowed.location.getSourceFile()
  const declaration = file.statements[0]
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  const reference = (declaration.body.statements[0] as ts.ExpressionStatement).expression
  assert.equal(ordinaryCallableBuiltinDataWriteOf('call', reference, shadowed.context), null)
})

test('program symbol origin follows actual const factory and value aliases', () => {
  const { context, location } = contextOf(
    `
      const factory = Symbol
      const fresh = factory('fresh')
      const alias = fresh
      const registry = Symbol.for
      const registered = registry('registered')
      const member = 'for' as const
      const computed = factory[member]('computed')
      alias; registered; computed;
    `,
    'alias'
  )
  const references = location
    .getSourceFile()
    .statements.filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
  for (const reference of references) {
    const origin = programSymbolOriginOf(reference, context)
    assert.equal(origin !== null, true, reference.getText())
    assert.equal(ordinaryCallableProgramSymbolDataWriteIsAbsent(reference, location, context), true, reference.getText())
    assert.equal(origin?.requirements.length, 1)
    const registry = reference.getText() !== 'alias'
    assert.equal(origin?.kind, registry ? 'registry' : 'fresh')
    assert.equal(origin?.requirements[0]?.intrinsic, 'Symbol')
    assert.equal(origin?.requirements[0]?.member, registry ? 'for' : undefined)
    const declaration = origin?.call.parent
    assert.equal(declaration !== undefined && ts.isVariableDeclaration(declaration), true)
    assert.equal(
      declaration && ts.isVariableDeclaration(declaration) ? declaration.name.getText() : '',
      registry ? reference.getText() : 'fresh'
    )
  }
})

test('symbol type annotations and erased assertions cannot impersonate factory provenance', () => {
  for (const setup of [
    'const fresh = Symbol(); const key = Symbol.hasInstance as any as typeof fresh',
    'const key: unique symbol = Symbol.hasInstance as any',
    'declare const source: any; const key: unique symbol = source',
    'declare const key: unique symbol',
    'let key = Symbol()',
    'const key = "label" as any as symbol'
  ]) {
    const { context, location } = contextOf(setup, 'key')
    assert.equal(programSymbolOriginOf(location, context) === null, true, setup)
    assert.equal(ordinaryCallableProgramSymbolDataWriteIsAbsent(location, location, context), false, setup)
  }
  const shadowed = contextOf(`
    function inspect(Symbol: (value?: string) => symbol) { Symbol('key'); }
  `)
  const declaration = shadowed.location.getSourceFile().statements[0]
  assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body)
  const key = (declaration.body.statements[0] as ts.ExpressionStatement).expression
  assert.equal(programSymbolOriginOf(key, shadowed.context) === null, true)
})

test('factory provenance obligations reject replaced Symbol and Symbol.for', () => {
  for (const setup of [
    'Symbol.for = (_name: string) => Symbol.hasInstance; const key = Symbol.for("key")',
    ';(globalThis as any).Symbol = () => Symbol.hasInstance; const key = Symbol()'
  ]) {
    const { context, location } = contextOf(setup, 'key')
    // The source records the actual stock declaration. Mutation integrity is
    // a separate final obligation, and cannot be inferred from that spelling.
    assert.equal(programSymbolOriginOf(location, context) !== null, true, setup)
    assert.equal(ordinaryCallableProgramSymbolDataWriteIsAbsent(location, location, context), false, setup)
  }
})

test('any program symbol prototype mutation revokes program symbol absence', () => {
  for (const intrinsic of ['Function', 'Object']) {
    const { context, location } = contextOf(
      `const other = Symbol('other'); (${intrinsic}.prototype as any)[other] = 1; const key = Symbol('key')`,
      'key'
    )
    assert.equal(programSymbolOriginOf(location, context) !== null, true)
    assert.equal(ordinaryCallableProgramSymbolDataWriteIsAbsent(location, location, context), false, intrinsic)
  }
})

test('named-key mutation is separate from program symbols but unknown declared symbols cannot prove absence', () => {
  const named = contextOf(';(Function.prototype as any).label = 1; const key = Symbol()', 'key')
  assert.equal(ordinaryCallableProgramSymbolDataWriteIsAbsent(named.location, named.location, named.context), true)
  const declared = contextOf('declare const extra: unique symbol; interface Function { [extra]: number }; const key = Symbol()', 'key')
  assert.equal(ordinaryCallableProgramSymbolDataWriteIsAbsent(declared.location, declared.location, declared.context), false)
})
