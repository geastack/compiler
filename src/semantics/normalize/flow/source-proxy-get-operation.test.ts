import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import { sourceProxyGetOperationsOf } from './source-proxy-operation.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-proxy-get-operation.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host)
  host.getSourceFile = (path, version, ...rest) =>
    resolve(path) === entry ? ts.createSourceFile(path, 'export {}\n' + source, version, true) : original(path, version, ...rest)
  const program = ts.createProgram([entry], options, host),
    checker = program.getTypeChecker(),
    file = program.getSourceFile(entry)!
  const files = program.getSourceFiles(),
    flow = indexValueFlow(checker, files, wholeProgram)
  attachStatedModuleSet(flow, { files, entries: [file], reachable: wholeProgram })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const operations: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isNewExpression(node.expression))
      operations.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(operations.length)
  return ledger.capture(() => operations.map((operation) => sourceProxyGetOperationsOf(checker, flow, operation))).value
}

test('get entry retains actual trap and separate raw target/Proxy receiver', () => {
  const [entries] = inspect(
    'class Subject { constructor(){return new Proxy(this,{get(t,key,receiver){return receiver}})}} new Subject().value'
  )
  assert.equal(entries?.length, 1)
  const entry = entries![0]!
  assert.equal(entry.key, 'value')
  assert.equal(entry.body.getText(), 'get(t,key,receiver){return receiver}')
  assert.equal(entry.context.targets[0]?.kind, 'base-constructor-allocation')
  assert.equal(entry.receiver, entry.context.result)
  assert.notEqual(entry.receiver, entry.context.construction)
})

test('same trap body retains distinct outer construction contexts', () => {
  const [first, second] = inspect(
    'class Subject { constructor(){return new Proxy(this,{get(t,key,r){return r}})}} new Subject().one; new Subject()["two"]'
  )
  assert.ok(first && second)
  assert.equal(first[0]!.body, second[0]!.body)
  assert.notEqual(first[0]!.context.construction, second[0]!.context.construction)
  assert.equal(first[0]!.key, 'one')
  assert.equal(second[0]!.key, 'two')
})

test('a foreign get return never selects the declared class method', () => {
  const [entries] = inspect(
    'const foreign=()=>2;class Subject {value(){return 1} constructor(){return new Proxy(this,{get(t,key,r){return foreign}})}} new Subject().value'
  )
  assert.equal(entries?.[0]?.body.getText(), 'get(t,key,r){return foreign}')
  assert.equal(entries?.[0]?.context.targets[0]?.kind, 'base-constructor-allocation')
})

test('unknown, escaped and mutated handler consumers refuse operation entry', () => {
  for (const extra of ['expose(handler)', 'handler.get(t,"value",t)', 'handler.get=()=>1']) {
    assert.equal(
      inspect(
        `declare function expose(x:unknown):void;declare const t:any;const handler={get(t:any,key:any,r:any){return r}};${extra};class Subject{constructor(){return new Proxy(this,handler)}}new Subject().value`
      )[0],
      null,
      extra
    )
  }
})

test('missing trap and receiver-dependent handler this stay refused', () => {
  for (const handler of ['{}', '{get(t,key,r){return this}}'])
    assert.equal(inspect(`class Subject{constructor(){return new Proxy(this,${handler})}}new Subject().value`)[0], null)
})
