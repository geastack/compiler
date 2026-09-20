import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { censusParameterBindings, indexParameterBindingProgram } from '../parameter-bindings.js'
import { attachStatedModuleSet } from './targets.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'
import { indexValueFlow } from './value-flow.js'

const programFor = (entrySource: string, reexport = false) => {
  const source = resolve('test/fixtures/class-origin-source.ts')
  const entry = resolve('test/fixtures/class-origin-entry.ts')
  const barrel = resolve('test/fixtures/class-origin-barrel.ts')
  const contents = new Map([
    [source, 'export class Receiver { hook() {} } export function inspect(value) { console.log(value.hook === value.hook) }'],
    [entry, `declare function external(value: unknown): void; ${entrySource}`]
  ])
  if (reexport) contents.set(barrel, 'export { Receiver as Alias } from "./class-origin-source"')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => {
    const text = contents.get(resolve(name))
    return text === undefined ? original(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
  }
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => ({ resolvedFileName: resolve(dirname(containingFile), `${name}.ts`), extension: ts.Extension.Ts }))
  const program = ts.createProgram([...contents.keys()], options, host)
  const diagnostics = program.getSemanticDiagnostics()
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')
  )
  const checker = program.getTypeChecker()
  const files = [...contents.keys()].map((name) => program.getSourceFile(name)!)
  return { checker, files, flow: indexValueFlow(checker, files, wholeProgram) }
}

const constructorIsClosed = (entrySource: string, reexport = false): boolean => {
  const { checker, files, flow } = programFor(entrySource, reexport)
  const declaration = files[0]!.statements.find(ts.isClassDeclaration)!
  const type = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(declaration.name!)!)
  assert.ok(type.isClassOrInterface())
  return classConstructorKeepsInstanceOf(checker, flow, type)
}

test('resolved named and namespace constructor imports retain known construction uses', () => {
  assert.equal(constructorIsClosed('import {Receiver} from "./class-origin-source"; new Receiver();'), true)
  assert.equal(constructorIsClosed('import * as api from "./class-origin-source"; new api.Receiver();'), true)
})

test('an imported constructor cannot hide an opaque consumer from its declaring class', () => {
  assert.equal(constructorIsClosed('import {Receiver as Alias} from "./class-origin-source"; external(Alias); new Alias();'), false)
  assert.equal(constructorIsClosed('import {Alias} from "./class-origin-barrel"; external(Alias); new Alias();', true), false)
})

test('an escaped module namespace exposes its exported constructor values', () => {
  assert.equal(constructorIsClosed('import * as api from "./class-origin-source"; external(api); new api.Receiver();'), false)
})

test('ordinary imported function forwarding retains its complete receiver parameter evidence', () => {
  const { checker, files } = programFor(`
    import { inspect } from "./class-origin-source";
    class Local { hook(value: any) {} }
    const local = new Local();
    local.hook = function(value) { return value.amount };
    inspect(local);
    local.hook({ amount: 3 });
  `)
  const assignment = files[1]!.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .find((expression) => ts.isBinaryExpression(expression) && ts.isFunctionExpression(expression.right))
  assert.ok(assignment && ts.isBinaryExpression(assignment) && ts.isFunctionExpression(assignment.right))
  const parameter = assignment.right.parameters[0]!
  for (const stated of [false, true]) {
    const index = indexParameterBindingProgram(checker, files, wholeProgram)
    if (stated) attachStatedModuleSet(index.valueFlow, { files, entries: [files[1]!], reachable: wholeProgram })
    const census = censusParameterBindings(checker, files, wholeProgram, undefined, index)
    const type = census.typeAt(parameter)
    if (stated) assert.ok(type && checker.getPropertyOfType(type, 'amount'))
    else assert.ok(type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
  }
})
