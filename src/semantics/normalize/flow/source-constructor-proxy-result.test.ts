import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachStatedModuleSet } from './targets.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { sourceRawConstructorAllocationOf } from './source-raw-constructor-entry.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

const inspect = (source: string, name='Subject') => {
  const entry=resolve('test/fixtures/source-constructor-proxy-result.ts')
  const options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,strict:true,types:[]}
  const host=ts.createCompilerHost(options), original=host.getSourceFile.bind(host)
  host.getSourceFile=(path,version,...rest)=>resolve(path)===entry
    ?ts.createSourceFile(path,'export {}\n'+source,version,true):original(path,version,...rest)
  const program=ts.createProgram([entry],options,host),checker=program.getTypeChecker(),file=program.getSourceFile(entry)!
  const files=program.getSourceFiles(),flow=indexValueFlow(checker,files,wholeProgram)
  attachStatedModuleSet(flow,{files,entries:[file],reachable:wholeProgram})
  const ledger=createDeferredIntrinsicProtocolLedger();attachDeferredIntrinsicProtocolLedger(flow,ledger)
  const session=sourceValueSessionOf(checker,flow),calls:ts.NewExpression[]=[]
  let receiver:ts.ThisExpression|undefined
  const visit=(node:ts.Node):void=>{
    if(ts.isNewExpression(node)&&node.expression.getText()===name)calls.push(node)
    if(node.kind===ts.SyntaxKind.ThisKeyword&&!receiver)receiver=node as ts.ThisExpression
    ts.forEachChild(node,visit)
  };visit(file);assert.ok(calls.length)
  return ledger.capture(()=>calls.map(call=>({call,
    results:session.constructorProxyResultIdentitiesOf(call),
    generic:session.valuesOf(call),closed:session.closedValuesOf(call),
    raw:receiver?sourceRawConstructorAllocationOf(checker,flow,receiver):null
  }))).value
}

test('a specific base constructor records separate raw allocation and returned Proxy',()=>{
  const [one]=inspect('class Subject { constructor(){const raw=this;const result=new Proxy(raw,{});return result} } new Subject()')
  assert.equal(one?.results?.length,1)
  const result=one!.results![0]!
  assert.equal(result.targets[0]?.kind,'base-constructor-allocation')
  assert.equal(result.construction,one?.call)
  assert.notEqual(result.result,result.construction)
  assert.equal(result.handlers[0]?.getText(),'{}')
  assert.equal(one?.generic,null);assert.equal(one?.closed,null);assert.equal(one?.raw,null)
})

test('two callers keep context-specific arguments and raw allocation origins',()=>{
  const [first,second]=inspect('class Subject {constructor(handler:object){return new Proxy(this,handler)}} new Subject({id:"first"});new Subject({id:"second"})')
  assert.ok(first?.results&&second?.results)
  assert.notEqual(first.results[0]?.construction,second.results[0]?.construction)
  assert.equal(first.results[0]?.result,second.results[0]?.result,'the body site is shared, not runtime object equality')
  assert.equal(first.results[0]?.handlers[0]?.getText(),'{id:"first"}')
  assert.equal(second.results[0]?.handlers[0]?.getText(),'{id:"second"}')
})

test('omitted and explicit undefined arguments use the actual constructor default',()=>{
  for(const call of ['new Subject()','new Subject(undefined)']){
    const [one]=inspect(`class Subject {constructor(handler:object={}){return new Proxy(this,handler)}} ${call}`)
    assert.equal(one?.results?.[0]?.handlers[0]?.getText(),'{}')
  }
})

test('a foreign returned Proxy target is not relabeled as the constructor allocation',()=>{
  const [one]=inspect('const foreign={};class Subject {constructor(){return new Proxy(foreign,{})}}new Subject()')
  assert.equal(one?.results?.[0]?.targets[0]?.kind,'source-object')
})

test('raw, primitive, fallthrough and unknown return alternatives refuse all-Proxy completion',()=>{
  for(const body of [
    'return this',
    'if(Date.now())return new Proxy(this,{});return this',
    'if(Date.now())return new Proxy(this,{})',
    'return 1 as any',
    'return unknownResult()'
  ]) {
    const [one]=inspect(`declare function unknownResult():any;class Subject {constructor(){${body}}}new Subject()`)
    assert.equal(one?.results,null,body)
  }
})

test('derived constructors are not entered from declared heritage without live dispatch integrity',()=>{
  const [one]=inspect('class Parent {constructor(){return new Proxy(this,{})}}class Subject extends Parent {}new Subject()')
  assert.equal(one?.results,null)
})

test('unknown handler and parameter rebinding cannot invent a contextual operand',()=>{
  for(const source of [
    'declare const handler:any;class Subject{constructor(){return new Proxy(this,handler)}}new Subject()',
    'class Subject{constructor(handler:object={}){handler=null as any;return new Proxy(this,handler)}}new Subject()',
    'declare const Proxy:any;class Subject{constructor(){return new Proxy(this,{})}}new Subject()'
  ])assert.equal(inspect(source)[0]?.results,null,source)
})

test('specific construction identity does not close escaped result consumers',()=>{
  const [one]=inspect('declare function expose(value:unknown):void;class Subject{constructor(){return new Proxy(this,{})}}expose(new Subject())')
  assert.ok(one?.results)
  assert.equal(one.closed,null);assert.equal(one.raw,null)
})

test('contextual handler selection uses complete source condition facts',()=>{
  for(const [condition,expected] of [
    ['null','no'],['undefined','no'],['false','no'],['0','no'],['""','no'],
    ['true','yes'],['1','yes'],['"x"','yes'],['{}','yes'],['(()=>{})','yes']
  ]){
    const [one]=inspect(`const choice=${condition};const yes={id:"yes"},no={id:"no"};class Subject{constructor(){const handler=choice?yes:no;return new Proxy(this,handler)}}new Subject()`)
    assert.deepEqual(one?.results?.[0]?.handlers.map(value=>value.getText()),[`{id:"${expected}"}`],condition)
  }
})

test('known false factory does not invent invocation of its unselected opaque arm',()=>{
  const [one]=inspect('const factory=null;declare function missing():object;class Subject{constructor(){const handler=factory?missing():{};return new Proxy(this,handler)}}new Subject()')
  assert.equal(one?.results?.[0]?.handlers[0]?.getText(),'{}')
})

test('complete mixed or unknown-truth condition families retain both handler arms',()=>{
  for(const prefix of [
    'let choice:object|null=null;if(Date.now())choice={}',
    'const choice=Date.now()>0'
  ]){
    const [one]=inspect(`${prefix};const yes={id:"yes"},no={id:"no"};class Subject{constructor(){return new Proxy(this,choice?yes:no)}}new Subject()`)
    assert.deepEqual(one?.results?.[0]?.handlers.map(value=>value.getText()).sort(),['{id:"no"}','{id:"yes"}'])
  }
})

test('an opaque or externally supplied factory path cannot be dropped as null',()=>{
  for(const prefix of [
    'declare const factory:any',
    'let factory:(()=>object)|null=null;export function replace(next:()=>object){factory=next}'
  ]){
    const [one]=inspect(`${prefix};class Subject{constructor(){return new Proxy(this,factory?factory():{})}}new Subject()`)
    assert.equal(one?.results,null,prefix)
  }
})
