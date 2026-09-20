import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { sourceRecordDataWritePlanOf } from './source-record-data.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import type { OriginAuthority } from './origin-authority.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

/** `storage` supplies the fixture's native protocol permission. */
const planFor = (source: string, completeParameters = true, storage = false, verifyCache = false) => {
  const entry = resolve('test/fixtures/source-record-data.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  let receiver: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'target') receiver = node.expression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(receiver)
  const complete = closedCallableAuthorityOf(
    checker,
    flow,
    (expression) => checker.getTypeAtLocation(expression),
    () => undefined
  )
  const authority: OriginAuthority = {
    ...complete,
    parameterValuesOf: (parameter) => (completeParameters ? complete.parameterValuesOf(parameter) : null),
    protocolClosed: () => storage,
    numericKey: () => storage,
    recordSlotClosed: () => false
  }
  const query = () => sourceRecordDataWritePlanOf(flow, receiver!, 'target', authority)
  if (!verifyCache) return query()
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const first = ledger.capture(query)
  assert.ok(first.value)
  assert.ok(first.requirements.some((requirement) => requirement.intrinsic === 'Function'))
  const repeated = ledger.capture(query)
  assert.equal(repeated.value, first.value, 'the second query uses the cached fact')
  assert.deepEqual(repeated.requirements, first.requirements)
  assert.equal(query(), null, 'a cached fact cannot escape the obligations that justify it')
  return first.value
}

test('record parameter origins replay explicit invocation obligations on cache hits', () => {
  const plan = planFor(
    `function fire(this: object, event: { target: null }) { event.target = null }
    fire.call({}, { target: null });`,
    true,
    false,
    true
  )
  assert.equal(plan?.roots.length, 1)
})

test('literal record writes distinguish own data, missing slots, and null prototypes', () => {
  assert.equal(planFor('const event = {target:null}; event.target = null;')?.needsDefaultPrototype, false)
  assert.equal(planFor('const event = {type:"dispose"}; event.target = null;')?.needsDefaultPrototype, true)
  assert.equal(planFor('const event = {__proto__:null,type:"dispose"}; event.target = null;')?.needsDefaultPrototype, false)
})

test('record allocation origins include every alias write and complete source parameter input', () => {
  const plan = planFor(`function fire(event: {target?:unknown}) { event.target = null; }
    const first = {type:'first'};
    let selected = first;
    selected = {target:null};
    fire(selected);`)
  assert.equal(plan?.roots.length, 2)
  assert.equal(plan?.needsDefaultPrototype, true)
  assert.equal(planFor('function fire(event: {target?:unknown}) { event.target=null; } fire({});', false), null)
})

test('opaque record origins and descriptor-producing literals cannot establish plain writes', () => {
  for (const initializer of [
    'external()',
    '{get target() { return null; }}',
    '{set target(value:unknown) {}}',
    '{__proto__:external()}',
    '{...external(),target:null}',
    '{[external()]:null}'
  ]) {
    assert.equal(planFor(`declare function external(): any; const event=${initializer}; event.target=null;`), null, initializer)
  }
  assert.equal(planFor('declare function external(): any; let event={target:null}; event=external(); event.target=null;'), null)
})

test('conditional record alternatives retain missing-slot obligations', () => {
  assert.equal(planFor('declare const choice:boolean; const event=choice?{target:null}:{}; event.target=null;')?.roots.length, 2)
  assert.equal(
    planFor('declare const choice:boolean; const event=choice?{target:null}:{}; event.target=null;')?.needsDefaultPrototype,
    true
  )
  assert.equal(
    planFor('declare const choice:boolean; const event=choice?{target:null}:{__proto__:null}; event.target=null;')?.needsDefaultPrototype,
    false
  )
})

test('origin-only cycles cannot borrow an allocation from a separate branch', () => {
  assert.equal(
    planFor('declare const choose:boolean; let a:any; let b:any; a=b; b=a; const event=choose?a:{target:null}; event.target=null;'),
    null
  )
  assert.equal(
    planFor('declare const choose:boolean; let a:any; let b:any; a=b; b=a; const event=choose?{target:null}:a; event.target=null;'),
    null
  )
  const repeated = planFor(
    'declare const choose:boolean; const first={target:null}; const left=first; const right=first; const event=choose?left:right; event.target=null;'
  )
  assert.equal(repeated?.roots.length, 1)
  assert.equal(repeated?.needsDefaultPrototype, false)
})

test('a reuse pool closes on the literal that seeds it', () => {
  const pool = `const renderItems: any[] = [];
    let renderItemsIndex = 0;
    function next(object: unknown) {
      let renderItem = renderItems[renderItemsIndex];
      if (renderItem === undefined) {
        renderItem = { object: object, target: null };
        renderItems[renderItemsIndex] = renderItem;
      } else {
        renderItem.target = object;
      }
      renderItemsIndex++;
      return renderItem;
    }
    next({});`
  const plan = planFor(pool, true, true)
  assert.equal(plan?.roots.length, 1)
  assert.ok(plan?.roots[0]?.getText().includes('object: object'))
  assert.equal(plan?.needsDefaultPrototype, false)
  // Without the storage authority an element read is not an origin at all.
  assert.equal(planFor(pool), null)
  assert.equal(
    planFor(pool.replace('next({});', 'declare function external(value: unknown): void; external(renderItems);'), true, true),
    null
  )
  assert.equal(planFor(pool.replace('next({});', 'declare function external(): any; renderItems.push(external());'), true, true), null)
})

test('an unseeded storage cycle stays refused', () => {
  assert.equal(planFor('const pool: any[] = []; let item = pool[0]; pool[0] = item; item.target = null;', true, true), null)
  assert.equal(planFor('const pool: any[] = []; let item = pool[0]; pool.push(item); item.target = null;', true, true), null)
})

test('native map reads and empty slots contribute their stored allocations only', () => {
  const read = planFor(
    'const pool = new Map<number, {target: unknown}>(); pool.set(1, {target: null}); const event = pool.get(1); if (event) event.target = null;',
    true,
    true
  )
  assert.equal(read?.roots.length, 1)
  assert.equal(read?.needsDefaultPrototype, false)
  assert.equal(
    planFor(
      'const pool = new Map<number, any>(); pool.set(1, {target: null}); const event = pool.get(1); event.target = null;',
      true,
      false
    ),
    null
  )
  const nullable = planFor('let event: {target: unknown} | null = null; event = {target: 1}; if (event) event.target = null;')
  assert.equal(nullable?.roots.length, 1)
  assert.equal(planFor('const event: any = null; event.target = null;'), null)
})

test('nested object mutations do not replace the record slot carrying that object', () => {
  const source = `
    const holder = { value: { target: null, extra: 1 } };
    delete holder.value.extra;
    holder.value.extra = 2;
    holder.value.target = null;
  `
  assert.equal(planFor(source, true, true)?.roots.length, 1)
  assert.equal(planFor(source.replace('delete holder.value.extra;', 'holder.value = { target: null, extra: 3 };'), true, true), null)
})
