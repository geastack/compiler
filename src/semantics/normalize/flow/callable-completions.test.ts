import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusReachability, wholeProgram } from '../reachability.js'
import { callableCompletionSummaryOf, callableCompletionValuesOf } from './callable-completions.js'
import { indexValueFlow } from './value-flow.js'

const inspect = (
  source: string,
  reachabilityOf: (checker: ts.TypeChecker, file: ts.SourceFile) => typeof wholeProgram = () => wholeProgram
) => {
  const entry = resolve('test/fixtures/callable-completions.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], reachabilityOf(checker, file))
  const declarations = new Map<string, ts.SignatureDeclaration>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node)
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { flow, file, declarations }
}

test('completion summaries retain explicit values beside bare return and fallthrough', () => {
  const { flow, file, declarations } = inspect(`
    function early(choice: boolean) { if (choice) return { first: 1 } }
    function bare(choice: boolean) { if (choice) return { first: 1 }; return }
    function closed(choice: boolean) { if (choice) return { first: 1 }; else return { second: 2 } }
    function throwsOnly() { throw new Error() }
  `)
  const early = declarations.get('early')!
  assert.equal(flow.callableBodyIsIndexed(early), true)
  const earlySummary = callableCompletionSummaryOf(flow, early)!
  assert.deepEqual(
    earlySummary.values.map((value) => value.getText(file)),
    ['{ first: 1 }']
  )
  assert.equal(earlySummary.mayFallThrough, true)
  assert.equal(earlySummary.mayCompleteUndefined, true)
  assert.equal(callableCompletionValuesOf(flow, early), null)

  const bare = declarations.get('bare')!
  const bareSummary = callableCompletionSummaryOf(flow, bare)!
  assert.deepEqual(
    bareSummary.values.map((value) => value.getText(file)),
    ['{ first: 1 }']
  )
  assert.equal(bareSummary.mayFallThrough, false)
  assert.equal(bareSummary.mayCompleteUndefined, true)
  assert.equal(callableCompletionValuesOf(flow, bare), null)

  const closed = declarations.get('closed')!
  const closedSummary = callableCompletionSummaryOf(flow, closed)!
  assert.deepEqual(closedSummary.values.map((value) => value.getText(file)).sort(), ['{ first: 1 }', '{ second: 2 }'])
  assert.equal(closedSummary.mayFallThrough, false)
  assert.equal(closedSummary.mayCompleteUndefined, false)
  assert.equal(callableCompletionValuesOf(flow, closed)?.length, 2)

  const throwsOnly = declarations.get('throwsOnly')!
  const throwSummary = callableCompletionSummaryOf(flow, throwsOnly)!
  assert.deepEqual(throwSummary.values, [])
  assert.equal(throwSummary.mayFallThrough, false)
  assert.equal(throwSummary.mayCompleteUndefined, false)
  assert.equal(callableCompletionValuesOf(flow, throwsOnly), null)
})

test('completion summaries preserve async and generator execution modes plus yielded values', () => {
  const { flow, file, declarations } = inspect(`
    async function asyncValue() { return { value: 1 } }
    function* generated() { yield { yielded: 1 }; return { returned: 2 } }
    async function* asyncGenerated() { yield { yielded: 3 }; return { returned: 4 } }
  `)
  const asyncValue = callableCompletionSummaryOf(flow, declarations.get('asyncValue')!)!
  assert.equal(asyncValue.execution, 'async')
  assert.deepEqual(
    asyncValue.values.map((value) => value.getText(file)),
    ['{ value: 1 }']
  )
  assert.equal(callableCompletionValuesOf(flow, declarations.get('asyncValue')!), null)

  const generated = callableCompletionSummaryOf(flow, declarations.get('generated')!)!
  assert.equal(generated.execution, 'generator')
  assert.deepEqual(
    generated.values.map((value) => value.getText(file)),
    ['{ returned: 2 }']
  )
  assert.deepEqual(
    generated.yields.map((value) => value.getText(file)),
    ['{ yielded: 1 }']
  )
  assert.equal(callableCompletionValuesOf(flow, declarations.get('generated')!), null)

  const asyncGenerated = callableCompletionSummaryOf(flow, declarations.get('asyncGenerated')!)!
  assert.equal(asyncGenerated.execution, 'async-generator')
  assert.deepEqual(
    asyncGenerated.values.map((value) => value.getText(file)),
    ['{ returned: 4 }']
  )
  assert.deepEqual(
    asyncGenerated.yields.map((value) => value.getText(file)),
    ['{ yielded: 3 }']
  )
})

test('expression-bodied arrows have one synchronous value completion', () => {
  const { flow, file } = inspect('const arrow = (value: object) => value;')
  const statement = file.statements.find(ts.isVariableStatement)!
  const declaration = statement.declarationList.declarations[0]!
  assert.ok(declaration.initializer && ts.isArrowFunction(declaration.initializer))
  const summary = callableCompletionSummaryOf(flow, declaration.initializer)!
  assert.equal(summary.execution, 'sync')
  assert.deepEqual(
    summary.values.map((value) => value.getText(file)),
    ['value']
  )
  assert.equal(summary.mayCompleteUndefined, false)
  assert.equal(summary.mayFallThrough, false)
  assert.deepEqual(
    callableCompletionValuesOf(flow, declaration.initializer)?.map((value) => value.getText(file)),
    ['value']
  )
})

test('completion summaries refuse pruned callable bodies while retaining indexed siblings', () => {
  const { flow, declarations } = inspect(
    `
      class Used {
        dead() { return { dead: true } }
        live() { return { live: true } }
      }
      new Used().live();
    `,
    (checker, file) => censusReachability({ checker, files: [file], entries: [file] })
  )

  const dead = declarations.get('dead')!
  const live = declarations.get('live')!
  assert.equal(flow.callableBodyIsIndexed(dead), false)
  assert.equal(flow.callableBodyIsIndexed(live), true)
  assert.equal(callableCompletionSummaryOf(flow, dead), null)
  assert.equal(callableCompletionSummaryOf(flow, live)?.values.length, 1)
})
