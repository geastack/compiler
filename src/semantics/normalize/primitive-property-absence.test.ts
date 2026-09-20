import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import { primitivePropertyIsAbsent } from './primitive-property-absence.js'
import { createStructuralTypeTable } from '../model/structural-type-table.js'
import { createStructuralMapper } from './structural.js'

const absent = (setup: string, type = 'number | boolean | string', key = 'marker'): boolean => {
  const entry = resolve('test/runtime/primitive-property-absence-input.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(
          name,
          // An unplaced value is read as possibly the global object only where the
          // program put a global object into its data. Several setups below patch a
          // prototype through a receiver typed `any` (`Object.getPrototypeOf(1)`),
          // and without that premise the census is right that nothing here can be
          // the global -- so the patch these cases exist to notice never reaches
          // the intrinsic surface.
          `${setup}\nconst globalHolder: { escaped: unknown } = { escaped: null }; globalHolder.escaped = globalThis;\ndeclare const input: ${type}; input;`,
          version,
          true
        )
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const expression = (file.statements[file.statements.length - 1] as ts.ExpressionStatement).expression
  const identities = createIdentityTable(program, checker)
  const taint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(),
    indexValueFlow(checker, [file], wholeProgram)
  )
  const table = createStructuralTypeTable()
  const types = createStructuralMapper(checker, identities, table)
  return primitivePropertyIsAbsent(expression, types.typeAt(expression), key, {
    checker,
    identities,
    table,
    globalHostMutationTaint: taint,
    isStandardLibraryDeclaration: (declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  })
}

test('missing primitive properties require an intact intrinsic prototype chain', () => {
  assert.equal(absent(''), true)
  for (const setup of [
    '(Number.prototype as any).marker = true;',
    'const prototype = Number.prototype; (prototype as any).marker = true;',
    'const holder = { prototype: Number.prototype }; (holder.prototype as any).marker = true;',
    'function change(prototype: any) { prototype.marker = true }; change(Number.prototype);',
    'function prototype() { return Number.prototype }; (prototype() as any).marker = true;',
    '(Object.getPrototypeOf(1) as any).marker = true;',
    'Object.setPrototypeOf(Number.prototype, { marker: true });',
    'Reflect.setPrototypeOf(Number.prototype, { marker: true });',
    'Reflect.set({}, "marker", true, Number.prototype);',
    'const holder = { prototype: Number.prototype }; Reflect.set({}, "marker", true, holder.prototype);',
    '(Number as any).prototype = { marker: true };',
    'Object.defineProperty(Boolean.prototype, "marker", { value: true });',
    '(Object.prototype as any).marker = true;',
    'declare function mutate(value: unknown): void; mutate(String.prototype);',
    'declare function mutate(value: unknown): void; mutate({ nested: { prototype: String.prototype } });'
  ])
    assert.equal(absent(setup), false, setup)
})

test('declared members, indexed characters, augmentations and open receiver arms are not absent', () => {
  assert.equal(absent('', 'number | string', 'toString'), false)
  assert.equal(absent('', 'number | string', 'hasOwnProperty'), false)
  assert.equal(absent('', 'number | string', '__proto__'), false)
  assert.equal(absent('', 'string', 'length'), false)
  assert.equal(absent('', 'string', '0'), false)
  assert.equal(absent('export {}; type String = { custom: number };', 'string', 'charAt'), false)
  assert.equal(absent('interface Number { marker: boolean }'), false)
  assert.equal(absent('', 'number | { marker: boolean }'), false)
  assert.equal(absent('', 'unknown'), false)
  assert.equal(absent('', 'any'), false)
})
