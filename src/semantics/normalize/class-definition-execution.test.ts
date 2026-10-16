import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'
import type { IrOperation } from '../../ir/model.js'
import { operationOfResult } from '../../identity/ids.js'

const entry = resolve('test/fixtures/class-definition-execution.ts')
const compiled = (source: string) => {
  const result = compile({ rootFileNames: [entry], projectFileName: null, includeIr: true, sourceOverlay: new Map([[entry, source]]) })
  assert.ok(result.certificate && result.source, JSON.stringify({ refusals: result.refusals, diagnostics: result.diagnostics }))
  return result
}
const operations = (result: ReturnType<typeof compiled>) =>
  result.irBodies!.flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))

test('computed method and accessor key effects belong to class definition, not their uncalled bodies', () => {
  const result = compiled(`function methodKey():'method'{console.log('method');return 'method'}
    function getterKey():'getter'{console.log('getter');return 'getter'}
    function setterKey():'setter'{console.log('setter');return 'setter'}
    class C { [methodKey()](){return 1} get [getterKey()](){return 1} set [setterKey()](value:number){} }
    console.log('after')`)
  const functions = new Set(
    [...result.graph.operations.values()].flatMap((operation) =>
      operation.family === 'allocation' && operation.functionName?.endsWith('Key') && operation.callable ? [operation.callable] : []
    )
  )
  const calls = [...result.graph.operations.values()].filter(
    (operation) =>
      operation.family === 'invocation' &&
      operation.target.kind === 'exact' &&
      operation.target.target.kind === 'function' &&
      functions.has(operation.target.target.functionId)
  )
  assert.equal(calls.length, 3)
  assert.ok(calls.every((operation) => operation.caller.kind === 'region'))
})

test('static blocks have a real void callable and use the original evaluated class receiver', () => {
  const result = compiled(`class C { static { console.log(this === C) } }`)
  const ir = operations(result)
  assert.equal(ir.filter((operation) => operation.kind === 'allocate-constructor').length, 1)
  const blocks = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'class-lifecycle' && operation.event === 'run-static-block'
  )
  assert.equal(blocks.length, 1)
  const block = blocks[0]!
  const initializer = block.operands.find((operand) => operand.role === 'initializer')!
  assert.ok(initializer && initializer.source.kind === 'result')
  const allocation = result.graph.operations.get(result.graph.results.get(initializer.source.result)!)!
  assert.ok(allocation.family === 'allocation' && allocation.callable)
  const body = result.irBodies!.find((body) => body.sourceOwner === allocation.callable)!
  assert.ok(body.abi && body.abi.result.kind === 'void' && body.abi.receiver?.kind === 'constructor-family')
  const calls = ir.filter((operation): operation is Extract<IrOperation, { kind: 'call' }> => operation.kind === 'call')
  assert.ok(calls.some((call) => call.receiver?.representation.kind === 'constructor-family' && call.result === null))
})

test('the actual construction-effects source fixture remains certified and retains computed key calls', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/class-definition-construction-effects.runtime.ts')],
    projectFileName: null,
    includeIr: true
  })
  assert.ok(result.certificate && result.source, JSON.stringify({ refusals: result.refusals, diagnostics: result.diagnostics }))
  assert.ok(!result.source!.includes('DORMANT_CONSTRUCTOR_MUST_NOT_RUN'))
  const calls = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'invocation' && operation.caller.kind === 'region'
  )
  assert.ok(calls.length > 0)
})

test('all computed keys precede static fields and blocks, preserving their own source order', () => {
  const result = compiled(`function key(label:string):'method'{console.log(label);return 'method'}
    function mark(label:string):number{console.log(label);return 1}
    class C {
      static first=mark('field-a'); [key('key-a')](){return 1}
      static {mark('block-a')} static second=mark('field-b'); [key('key-b')](){return 2}
      static {mark('block-b')}
    } mark('after')`)
  const label = (operation: import('../../semantics/model/operations.js').SemanticOperation) => {
    if (operation.family !== 'invocation') return undefined
    const argument = operation.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 0)
    return argument?.source.kind === 'constant' && argument.source.literal === 'string' ? argument.source.text : undefined
  }
  const byOwner = new Map(
    [...result.graph.operations.values()].flatMap((operation) => {
      const text = label(operation)
      return text && operation.caller.kind === 'function' ? [[operation.caller.functionId, text] as const] : []
    })
  )
  const module = result.irBodies!.find((body) => result.graph.regions.get(body.sourceOwner as never)?.role === 'module-body')!
  const sequence = module.blockOrder.flatMap((id) =>
    module.blocks.get(id)!.operations.flatMap((operation) => {
      if (operation.kind !== 'call' || !operation.lineage) return []
      const semantic = result.graph.operations.get(operationOfResult(operation.lineage))
      if (!semantic) return []
      const text = label(semantic) ?? (semantic.family === 'allocation' && semantic.callable ? byOwner.get(semantic.callable) : undefined)
      return text ? [text] : []
    })
  )
  assert.deepEqual(sequence, ['key-a', 'key-b', 'field-a', 'block-a', 'field-b', 'block-b', 'after'])
})

for (const [name, source] of [
  [
    'outer lexical this in a computed static name',
    `function build(this:{key:'method'}) {
    const outer=this;class C {static [outer.key](){return 1}} return C
  } console.log(build.call({key:'method'}).name)`
  ],
  [
    'outer static this in a nested class computed name',
    `class Outer {
    static key:'method'='method'; static build(){const outer=this;class Inner {static [outer.key](){return 1}} return Inner}
  } console.log(Outer.build().name)`
  ],
  [
    'static block factory captures and arrow receiver',
    `function factory(label:string) {
    class C {static label=label;static read:()=>typeof C;static {this.read=()=>this;console.log(this===C)}} return C
  } const a=factory('a'),b=factory('b');console.log(a!==b,a.read()===a,b.read()===b,a.label,b.label)`
  ],
  [
    'separate static block locals',
    `class C {
    static first=0;static second=0;
    static {var value=1;this.first=value} static {var value=2;this.second=value}
  } console.log(C.first,C.second)`
  ],
  [
    'static block constructing its real receiver',
    `class C {
    static instance:C;value=1;static {this.instance=new this()} constructor(){console.log('constructor')}
  } console.log(C.instance.value)`
  ],
  [
    'computed name throwing before static effects',
    `function key():'method'{throw new Error('key')}
    function effect(){console.log('MUST_NOT_RUN');return 1} class C{static ready=effect();[key()](){return 1}}`
  ]
] as const)
  test(name, () => {
    const result = compiled(source)
    const thisReads = [...result.graph.operations.values()].filter(
      (operation) => operation.family === 'reference' && operation.form === 'this'
    )
    for (const operation of thisReads) assert.equal(operation.caller.kind, 'function')
    assert.ok(result.source)
  })

test('direct this in a computed TypeScript name retains the checker refusal', () => {
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([
      [entry, `function build(this:{key:'method'}) {class C{static [this.key](){return 1}}return C} build.call({key:'method'})`]
    ])
  })
  assert.equal(result.certificate, null)
  assert.ok(result.diagnostics.diagnostics.some((diagnostic) => diagnostic.id.startsWith('checker/2465/')))
})

test('heritage evaluates before keys, then static effects and subsequent statements', () => {
  const result = compiled(`class Base{} function heritage(){console.log('heritage');return Base}
    function key():'method'{console.log('key');return 'method'}
    function mark(label:string){console.log(label);return 1}
    class C extends heritage(){static ready=mark('static');[key()](){return 1}} mark('after')`)
  const textOf = (operation: import('../../semantics/model/operations.js').SemanticOperation) => {
    if (operation.family !== 'invocation') return undefined
    const argument = operation.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 0)
    return argument?.source.kind === 'constant' && argument.source.literal === 'string' ? argument.source.text : undefined
  }
  const labels = new Map(
    [...result.graph.operations.values()].flatMap((operation) => {
      const text = textOf(operation)
      return text && operation.caller.kind === 'function' ? [[operation.caller.functionId, text] as const] : []
    })
  )
  const module = result.irBodies!.find((body) => result.graph.regions.get(body.sourceOwner as never)?.role === 'module-body')!
  const sequence = module.blockOrder.flatMap((id) =>
    module.blocks.get(id)!.operations.flatMap((operation) => {
      if (operation.kind !== 'call' || !operation.lineage) return []
      const semantic = result.graph.operations.get(operationOfResult(operation.lineage))
      if (!semantic) return []
      const text =
        textOf(semantic) ??
        (semantic.family === 'allocation' && semantic.callable
          ? labels.get(semantic.callable)
          : semantic.family === 'invocation' && semantic.target.kind === 'exact' && semantic.target.target.kind === 'function'
            ? labels.get(semantic.target.target.functionId)
            : undefined)
      return text ? [text] : []
    })
  )
  assert.deepEqual(sequence, ['heritage', 'key', 'static', 'after'])
})

test('computed-key class binding TDZ observation is retained before public binding initialization', () => {
  const result = compiled(`function effect(){console.log('static');return 1}
    function key():'m'{console.log(C.name);return 'm'} class C{[key()](){}static ready=effect()}`)
  const module = result.irBodies!.find((body) => result.graph.regions.get(body.sourceOwner as never)?.role === 'module-body')!
  const ir = module.blockOrder.flatMap((id) => module.blocks.get(id)!.operations)
  const keys = new Set(
    [...result.graph.operations.values()].flatMap((operation) =>
      operation.family === 'allocation' && operation.functionName === 'key' && operation.callable ? [operation.callable] : []
    )
  )
  const call = ir.findIndex(
    (operation) => operation.kind === 'call' && operation.target?.kind === 'direct' && keys.has(operation.target.functionId)
  )
  const declaration = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'allocation' && operation.functionName === 'C' && operation.allocated === 'class-constructor-object'
  )
  assert.ok(declaration?.family === 'allocation' && declaration.classDeclaration)
  const initialized = ir.findIndex(
    (operation) => operation.kind === 'binding-write' && operation.declaration === declaration.classDeclaration
  )
  assert.ok(
    call >= 0 && initialized > call,
    'key evaluation precedes public class binding initialization; actual ReferenceError guard is a separate native observation'
  )
})

test('exact console-constructor TDZ probe retains unsupported stringification refusal', () => {
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        entry,
        `function effect(){console.log('static');return 1} function key():'m'{console.log(C);return 'm'} class C{[key()](){}static ready=effect()}`
      ]
    ])
  })
  assert.ok(result.certificate)
  assert.equal(result.source, null)
  assert.ok(result.refusals.some((refusal) => refusal.key === 'host-member-call:Console.log'))
  const key = [...result.graph.operations.values()].find((operation) => operation.family === 'allocation' && operation.functionName === 'key')
  assert.ok(key?.family === 'allocation' && key.callable)
  assert.ok([...result.graph.operations.values()].some((operation) => operation.family === 'invocation' && operation.caller.kind === 'function' && operation.caller.functionId === key.callable))
})
