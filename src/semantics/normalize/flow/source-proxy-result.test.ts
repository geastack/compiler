import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-proxy-result.ts')
  const options: ts.CompilerOptions = {target: ts.ScriptTarget.ES2022, strict: true, types: []}
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) => resolve(name) === entry
    ? ts.createSourceFile(name, 'export {}\n'+source, version, true) : original(name, version, ...rest)
  const program=ts.createProgram([entry],options,host), checker=program.getTypeChecker(), file=program.getSourceFile(entry)!
  const files=program.getSourceFiles(), flow=indexValueFlow(checker,files,wholeProgram)
  attachStatedModuleSet(flow,{files,entries:[file],reachable:wholeProgram})
  const ledger=createDeferredIntrinsicProtocolLedger(); attachDeferredIntrinsicProtocolLedger(flow,ledger)
  let proxy: ts.NewExpression | undefined
  const visit=(node:ts.Node):void=>{if(ts.isNewExpression(node)&&node.expression.getText()==='Proxy')proxy=node;ts.forEachChild(node,visit)}
  visit(file); assert.ok(proxy)
  const session=sourceValueSessionOf(checker,flow), expression=proxy
  return ledger.capture(()=>({values:session.valuesOf(expression),identity:session.proxyResultIdentityOf?.(expression),closed:session.closedValuesOf(expression)})).value
}

test('Proxy result, target and handler retain three distinct source identities',()=>{
  const result=inspect('const target={}; const handler={}; const proxy=new Proxy(target,handler)')
  assert.equal(result.values,null,'generic class-data consumers must not receive Proxy result tokens')
  assert.ok(result.identity,'explicit Proxy result domain retains the allocation identity')
  assert.equal(result.identity?.result.getText(),'new Proxy(target,handler)')
  assert.deepEqual(result.identity?.targets.map(one=>one.getText()),['{}'])
  assert.deepEqual(result.identity?.handlers.map(one=>one.getText()),['{}'])
  assert.notEqual(result.identity?.result,result.identity?.targets[0])
  assert.notEqual(result.identity?.targets[0],result.identity?.handlers[0])
  assert.equal(result.closed,null,'identity alone must not grant native trap/consumer closure')
})

test('unknown operands, nonobjects and shadowed construction refuse the relation',()=>{
  for(const source of [
    'declare const target:any; new Proxy(target,{})',
    'declare const handler:any; new Proxy({},handler)',
    'new Proxy(1 as any,{})',
    'declare const Proxy:any; new Proxy({},{})'
  ]) assert.equal(inspect(source).identity,null,source)
})

test('a get trap returning its target does not alias the Proxy or grant member lookup',()=>{
  const result=inspect('const target={}; const handler={get(t:object){return t}}; const proxy=new Proxy(target,handler); void proxy.anything')
  assert.ok(result.identity)
  assert.notEqual(result.identity.result,result.identity.targets[0])
  assert.equal(result.closed,null)
})

test('a returned Proxy does not relax raw source class construction result proof',()=>{
  const result=inspect('class Subject { constructor(){return new Proxy(this,{})} }; const value=new Subject()')
  assert.equal(result.identity,null,'raw this requires its separate allocation and consumer proof')
})
