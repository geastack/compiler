import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { sourceClassDataMemberPlanOf, sourceClassKeyReadPlanOf, type SourceClassFamilyQuery } from './source-class-data.js'
import { closedValueOriginAuthorityOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

const inspectPlan = (source: string, js = false, exact = false) => {
  const entry = resolve(`test/fixtures/source-class-data.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `export {};\n${source}`, version, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  let receiver: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'selected' && node.name.text === 'value')
      receiver = node.expression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(receiver)
  const query: SourceClassFamilyQuery = exact
    ? {
        kind: 'value',
        receiver: checker.getTypeAtLocation(receiver),
        expression: receiver,
        originsOf: closedValueOriginAuthorityOf(checker, flow, receiver).classAllocationsOf
      }
    : { kind: 'declared', receiver: checker.getTypeAtLocation(receiver) }
  return sourceClassDataMemberPlanOf(checker, flow, query, 'value')
}

const inspect = (source: string, js = false): boolean => inspectPlan(source, js) !== null

test('source data family ignores unrelated any constructor results and keeps nullable class alternatives', () => {
  assert.ok(
    inspect(`class Owner { value = {}; } class Child extends Owner {}
    declare const unrelated:any; new unrelated();
    const values = new Map<number, Child>(); values.set(1,new Child());
    const selected = values.get(1); selected.value;`)
  )
  assert.ok(
    inspect(
      `class Owner { constructor() { this.value = {}; } }
    function unrelated() { return {}; } new unrelated();
    /** @type {Map<number, Owner>} */ const values = new Map(); values.set(1,new Owner());
    const selected = values.get(1); selected.value;`,
      true
    )
  )
})

test('instantiated generic classes retain their source descriptor identity', () => {
  assert.ok(
    inspect(`class Owner<T> { constructor(public value:T) {} }
    const selected = new Owner({}); selected.value;`)
  )
})

test('every source subclass descriptor must remain data', () => {
  assert.equal(
    inspect(`class Owner { value = {}; }
    class Child extends Owner { get value() { return {}; } }
    const selected = new Owner(); new Child(); selected.value;`),
    false
  )
  assert.equal(
    inspect(`class Owner { value = {}; }
    class Child extends Owner { set value(value: object) {} }
    const selected = new Owner(); selected.value;`),
    false
  )
  assert.equal(
    inspect(`class Owner { get value() { return {}; } }
    const selected = new Owner(); selected.value;`),
    false
  )
})

test('opaque constructor families and prototype descriptor changes refuse data proof', () => {
  for (const extra of [
    'declare function external(value:unknown):void; class Hidden extends Owner {} external(Hidden);',
    'Object.defineProperty(Owner.prototype,"value",{get(){return {};}});',
    'declare const opaque:new()=>Owner; new opaque();'
  ])
    assert.equal(inspect(`class Owner { value = {}; } const selected = new Owner(); ${extra} selected.value;`), false, extra)
  assert.equal(inspect('declare const selected:any; selected.value;'), false)
  assert.equal(inspect('interface Owner {value:object} declare const selected:Owner; selected.value;'), false)
})

test('exact class allocations recover erased alias fields without merging distinct declarations', () => {
  const plan = inspectPlan(
    `class Owner { constructor() { this.value = {}; } }
    /** @type {any} */ let selected;
    const held = new Owner(); selected = held; selected.value;`,
    true,
    true
  )
  assert.ok(plan)
  assert.equal(plan.declarations.length, 1)
  assert.equal(plan.declarations[0]!.getText(), 'this.value = {}')
  const reassigned = inspectPlan(
    `class Owner {
    constructor() { this.value = {}; }
    replace() { this.value = {}; }
  }
  /** @type {any} */ const selected = new Owner(); selected.value;`,
    true,
    true
  )
  assert.equal(reassigned?.declarations.length, 1)
  const alternatives = inspectPlan(
    `class First { value = {}; } class Second { value = {}; }
    declare const choice:boolean; const selected:any = choice ? new First() : new Second(); selected.value;`,
    false,
    true
  )
  assert.ok(alternatives)
  assert.equal(alternatives.declarations.length, 2)
  assert.equal(
    inspectPlan(
      `declare function unknownOwner():any;
    class Owner { value = {}; } let selected:any = new Owner(); selected = unknownOwner(); selected.value;`,
      false,
      true
    ),
    null
  )
  assert.equal(
    inspectPlan(
      `class Owner { get value() { return {}; } }
    const selected:any = new Owner(); selected.value;`,
      false,
      true
    ),
    null
  )
})

/** The read `selected.<key>` classified over its class family, under an
 * active intrinsic ledger capture unless `ledger` is false. */
const keyRead = (source: string, key: string, { js = false, ledger = true }: { js?: boolean; ledger?: boolean } = {}) => {
  const entry = resolve(`test/fixtures/source-class-key-read.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `export {};\n${source}`, version, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const intrinsics = createDeferredIntrinsicProtocolLedger()
  if (ledger) attachDeferredIntrinsicProtocolLedger(flow, intrinsics)
  let receiver: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'selected' && node.name.text === key)
      receiver = node.expression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(receiver)
  const query: SourceClassFamilyQuery = {
    kind: 'value',
    receiver: checker.getTypeAtLocation(receiver),
    expression: receiver,
    originsOf: closedValueOriginAuthorityOf(checker, flow, receiver).classAllocationsOf
  }
  const { value: plan, requirements } = intrinsics.capture(() => sourceClassKeyReadPlanOf(checker, flow, query, key))
  if (plan?.needsDefaultPrototype) {
    assert.ok(requirements.some((requirement) => requirement.intrinsic === 'Object'))
    const cached = intrinsics.capture(() => sourceClassKeyReadPlanOf(checker, flow, query, key))
    assert.deepEqual(cached.requirements, requirements)
    assert.equal(sourceClassKeyReadPlanOf(checker, flow, query, key), null)
  }
  return plan
    ? {
        classes: Object.fromEntries([...plan.classes].map(([owner, verdict]) => [owner.name?.text ?? '(anonymous)', verdict])),
        codeFree: plan.codeFree,
        primitive: plan.primitive
      }
    : null
}

test('a key only some family classes declare reads absent or data without running code', () => {
  const source = `class Mesh { isMesh = true; } class InstancedMesh extends Mesh { isInstancedMesh = true; }
    declare const choose: boolean; const selected: Mesh = choose ? new Mesh() : new InstancedMesh(); selected.isInstancedMesh;`
  assert.deepEqual(keyRead(source, 'isInstancedMesh'), {
    classes: { Mesh: 'absent', InstancedMesh: 'data' },
    codeFree: true,
    primitive: true
  })
  assert.deepEqual(keyRead('class Mesh { isMesh = true; } const selected = new Mesh(); selected.isSkinnedMesh;', 'isSkinnedMesh'), {
    classes: { Mesh: 'absent' },
    codeFree: true,
    primitive: true
  })
  assert.deepEqual(
    keyRead('class Mesh { constructor() { this.isMesh = true; } } const selected = new Mesh(); selected.isMesh;', 'isMesh', { js: true }),
    { classes: { Mesh: 'data' }, codeFree: true, primitive: true }
  )
})

test('an absent key needs the intrinsic Object prototype and must not be one of its members', () => {
  const source =
    'class Mesh { isMesh = true; } const selected = new Mesh(); selected.isSkinnedMesh; selected.toString; selected.hasOwnProperty; selected.constructor;'
  assert.equal(keyRead(source, 'isSkinnedMesh', { ledger: false }), null)
  assert.equal(keyRead(source, 'toString'), null)
  assert.equal(keyRead(source, 'hasOwnProperty'), null)
  assert.equal(keyRead(source, 'constructor'), null)
})

test('a get/set pair that only forwards to a plain field on another object reads as that field', () => {
  const source = `class Source { constructor(public data: number) {} }
    class Texture { source: Source; constructor(s: Source) { this.source = s; }
      get image() { return this.source.data } set image(value: number) { this.source.data = value } }
    const selected = new Texture(new Source(1)); selected.image;`
  assert.deepEqual(keyRead(source, 'image'), { classes: { Texture: 'data' }, codeFree: true, primitive: true })
})

test('an accessor passthrough refuses when its target is itself an accessor, or when either half drifts from a plain forward', () => {
  const chainedAccessor = `class Source { get data() { return 1; } set data(v: number) {} }
    class Texture { source: Source; constructor(s: Source) { this.source = s; }
      get image() { return this.source.data } set image(value: number) { this.source.data = value } }
    const selected = new Texture(new Source()); selected.image;`
  assert.equal(keyRead(chainedAccessor, 'image')?.codeFree, false)

  const receiverAccessor = `class Source { data = 1 }
    class Texture { get source() { return new Source() } set source(value: Source) {}
      get image() { return this.source.data } set image(value: number) { this.source.data = value } }
    const selected = new Texture(); selected.image;`
  assert.equal(keyRead(receiverAccessor, 'image')?.codeFree, false)

  const receiverSubclassAccessor = `class Source { data = 1 }
    class DerivedSource extends Source { get data() { return 2 } set data(value: number) {} }
    class Texture { source: Source; constructor(s: Source) { this.source = s }
      get image() { return this.source.data } set image(value: number) { this.source.data = value } }
    const selected = new Texture(new DerivedSource()); selected.image;`
  assert.equal(keyRead(receiverSubclassAccessor, 'image')?.codeFree, false)

  const rhsIsNotTheParameter = `class Source { constructor(public data: number) {} }
    class Texture { source: Source; constructor(s: Source) { this.source = s; }
      get image() { return this.source.data } set image(value: number) { this.source.data = value + 1 } }
    const selected = new Texture(new Source(1)); selected.image;`
  assert.equal(keyRead(rhsIsNotTheParameter, 'image')?.codeFree, false)

  const getterDoesMoreThanReturn = `class Source { constructor(public data: number) {} }
    class Texture { source: Source; hits = 0; constructor(s: Source) { this.source = s; }
      get image() { this.hits++; return this.source.data } set image(value: number) { this.source.data = value } }
    const selected = new Texture(new Source(1)); selected.image;`
  assert.equal(keyRead(getterDoesMoreThanReturn, 'image')?.codeFree, false)
})

test('a data-member plan follows an accessor pair that forwards to a plain field', () => {
  assert.ok(
    inspect(`class Source { constructor(public data: number) {} }
    class Texture { source: Source; constructor(s: Source) { this.source = s; }
      get value() { return this.source.data } set value(v: number) { this.source.data = v } }
    const selected = new Texture(new Source(1)); selected.value;`)
  )
})

test('accessors, methods and receiver-carrying data are visible to the caller', () => {
  assert.equal(
    keyRead(
      'class Mesh {} class Odd extends Mesh { get isInstancedMesh() { return true; } } const selected: Mesh = new Odd(); new Mesh(); selected.isInstancedMesh;',
      'isInstancedMesh'
    )?.codeFree,
    false
  )
  assert.equal(
    keyRead('class Base { get k() { return 1; } } class Sub extends Base { k = 2; } const selected = new Sub(); selected.k;', 'k')
      ?.codeFree,
    false
  )
  assert.equal(keyRead('class Mesh { k() {} } const selected = new Mesh(); selected.k;', 'k')?.codeFree, false)
  const callable = keyRead(
    `function sink(value) {} class Mesh {} class Sub extends Mesh { constructor() { super(); this.k = () => sink(this); } }
    /** @type {Mesh} */ const selected = new Sub(); new Mesh(); selected.k;`,
    'k',
    { js: true }
  )
  assert.deepEqual(callable && { codeFree: callable.codeFree, primitive: callable.primitive }, { codeFree: true, primitive: false })
  assert.equal(
    keyRead('class Mesh { constructor() { this.self = this; } } const selected = new Mesh(); selected.self;', 'self', { js: true })
      ?.primitive,
    false
  )
  assert.equal(
    keyRead(
      'declare function external(value: unknown): void; class Mesh {} class Hidden extends Mesh {} external(Hidden); const selected = new Mesh(); selected.k;',
      'k'
    ),
    null
  )
})
