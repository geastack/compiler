import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'

const infer = (body: string, calls = 'wrap(-0.25); wrap(1.25);', parameter = 't', module = true) => {
  const entry = resolve('test/fixtures/parameter-write-evidence.js')
  const source = `${module ? 'export {};' : ''} function wrap(${parameter}) { ${body} } ${calls}`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const census = censusParameterBindings(checker, [file], wholeProgram)
  const declaration = file.statements.find(ts.isFunctionDeclaration)!.parameters[0]!
  const type = census.typeAt(declaration) ?? checker.getTypeAtLocation(declaration)
  return { type: checker.typeToString(type), refusals: census.refusals }
}

const numericWrap = 'if (t < 0) t += 1; if (t > 1) t -= 1; return t;'

test('complete numeric input and every numeric self-update retain the parameter carrier', () => {
  for (const body of [numericWrap, 't += t; return t;', 't = 0.5; t += 1; return t;', 't += 1; t = 0.5; return t;']) {
    const result = infer(body)
    assert.equal(result.type, 'number', JSON.stringify({ body, result }))
    assert.equal(
      result.refusals.some((refusal) => refusal.reason === 'parameter-reassigned'),
      false
    )
  }
})

test('numeric self-update proof cannot erase string or opaque incoming alternatives', () => {
  for (const calls of [
    "wrap('0.5'); wrap(0.5);",
    'wrap(globalThis.unknownValue); wrap(0.5);',
    'globalThis.unknownConsumer(wrap); wrap(0.5);',
    'wrap(); wrap(0.5);',
    'wrap(1n);'
  ])
    assert.notEqual(infer(numericWrap, calls).type, 'number', calls)
})

test('all body writes and both addition operands must preserve the numeric invariant', () => {
  for (const body of [
    "t = 'text'; t += 1; return t;",
    "t += 1; t = 'text'; return t;",
    "t += 'text'; return t;",
    't = globalThis.unknownValue; t += 1; return t;',
    't += globalThis.unknownValue; return t;',
    'function replace() { t = globalThis.unknownValue; } replace(); t += 1; return t;'
  ])
    assert.notEqual(infer(body).type, 'number', body)
})

test('an omitted unknown default cannot borrow another numeric caller as a seed', () => {
  assert.notEqual(infer(numericWrap, 'wrap(); wrap(0.5);', 't = globalThis.unknownValue').type, 'number')
})

test('mapped arguments writes cannot borrow a numeric parameter invariant', () => {
  assert.notEqual(infer("arguments[0] = 'text'; t += 1; return t;", 'wrap(0.5);', 't', false).type, 'number')
})
