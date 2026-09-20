import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../../compiler.js'
import { noPluginCapabilities, type CompilerPlugin } from '../../plugins/model.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { settleBindingCensus } from './binding-fixpoint.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'

test('convergence observes argument provenance even when types and binding counts stay unchanged', () => {
  const file = ts.createSourceFile(
    'argument-origins.ts',
    'function take(value) {}\nconst first = Date.prototype; const second = new Date();',
    ts.ScriptTarget.ES2022,
    true
  )
  const take = file.statements[0] as ts.FunctionDeclaration
  const first = (file.statements[1] as ts.VariableStatement).declarationList.declarations[0]!.initializer!
  const second = (file.statements[2] as ts.VariableStatement).declarationList.declarations[0]!.initializer!
  let rounds = 0
  const settled = settleBindingCensus((upstream) => {
    rounds++
    upstream?.argumentsAt?.(take.parameters[0]!)
    const argumentsRead = rounds === 1 ? [first] : [second]
    return { parameters: { ...emptyParameterBindingCensus, argumentsAt: () => argumentsRead }, facts: argumentsRead }
  })
  assert.equal(settled.round, 3, 'equal types do not mean equal source identities')
  assert.deepEqual(settled.facts, [second])
})

test('the composed frontend preserves inferred call targets and their argument writes', () => {
  const entry = resolve('test/fixtures/binding-composition.js')
  const source = `
    function composedForward(callback, value) { return callback(value) }
    function composedConsume(value) { return value.width }
    console.log(composedForward(composedConsume, { width: 10 }))
  `
  const observed = new Error('composed census observed')
  const observer: CompilerPlugin = {
    name: 'binding-composition-test',
    instantiate: () => ({
      lower: () => false,
      capabilities: noPluginCapabilities,
      producers: (context) => {
        const forward = context.checker.resolveName('composedForward', undefined, ts.SymbolFlags.Value, false)?.valueDeclaration
        const consume = context.checker.resolveName('composedConsume', undefined, ts.SymbolFlags.Value, false)?.valueDeclaration
        assert.ok(forward && ts.isFunctionDeclaration(forward))
        assert.ok(consume && ts.isFunctionDeclaration(consume))
        const statement = forward.body?.statements[0]
        assert.ok(statement && ts.isReturnStatement(statement) && statement.expression && ts.isCallExpression(statement.expression))
        const call = statement.expression
        assert.equal(context.checker.getResolvedSignature(call)?.declaration, undefined, 'this call needs inference')
        assert.equal(context.parameters.callDeclarationAt?.(call), consume, 'a wrapper dropped the solved callee identity')
        assert.deepEqual(context.parameters.callTargetsAt?.(call), [consume])
        const flow = indexValueFlow(
          context.checker,
          [forward.getSourceFile()],
          wholeProgram,
          (expression) => context.parameters.typeAt(expression),
          context.parameters.callDeclarationAt,
          context.parameters.callTargetsAt
        )
        assert.ok(
          flow
            .writesToDeclaration(consume.parameters[0]!)
            .some((write) => write.edge === 'call-argument' && write.value === call.arguments[0]),
          'the inferred call must contribute its actual argument to the shared write inventory'
        )
        throw observed
      }
    })
  }
  assert.throws(
    () =>
      compile({
        rootFileNames: [entry],
        projectFileName: null,
        javaScriptSources: true,
        sourceOverlay: new Map([[entry, source]]),
        plugins: [observer]
      }),
    (error) => error === observed
  )
})

test('convergence observes changes to executable targets with an unchanged static signature', () => {
  const file = ts.createSourceFile('target-origins.ts', 'function first() {} function second() {} first()', ts.ScriptTarget.ES2022, true)
  const first = file.statements[0] as ts.FunctionDeclaration
  const second = file.statements[1] as ts.FunctionDeclaration
  const call = (file.statements[2] as ts.ExpressionStatement).expression as ts.CallExpression
  let rounds = 0
  const settled = settleBindingCensus((upstream) => {
    rounds++
    upstream?.callTargetsAt?.(call)
    const targets = rounds === 1 ? [first] : [first, second]
    return {
      parameters: { ...emptyParameterBindingCensus, callDeclarationAt: () => first, callTargetsAt: () => targets },
      facts: targets
    }
  })
  assert.equal(settled.round, 3)
  assert.deepEqual(settled.facts, [first, second])
})
