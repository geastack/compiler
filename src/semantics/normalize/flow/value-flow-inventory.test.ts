import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { censusReachability, wholeProgram } from '../reachability.js'
import { censusParameterBindings } from '../parameter-bindings.js'

test('object property and shorthand publications retain their own member identity and source aliases', () => {
  const entry = resolve('test/fixtures/object-publication-inventory.js')
  const source = `const item = { value: 1 }; const alias = item;
    const box = { item, selected: alias, inner: { chosen: item } };
    box.item; box.selected; box.inner.chosen;
    let target; ({ item: target } = box);`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const declarations = file.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations])
  const item = declarations.find((declaration) => declaration.name.getText() === 'item')!
  const alias = declarations.find((declaration) => declaration.name.getText() === 'alias')!
  const publications = flow.allWrites.filter(
    (write) =>
      write.edge === 'property-assignment' &&
      write.slot === 'whole' &&
      write.member === null &&
      (ts.isPropertyAssignment(write.site) || ts.isShorthandPropertyAssignment(write.site))
  )
  const itemPublication = publications.find((write) => write.site.getText() === 'item')!
  const selected = publications.find((write) => write.site.getText() === 'selected: alias')!
  const nested = publications.find((write) => write.site.getText() === 'chosen: item')!
  assert.ok(itemPublication && selected && nested)
  assert.notEqual(itemPublication.target.declaration, item)
  assert.ok(flow.flowsFromDeclaration(item).includes(itemPublication))
  assert.ok(flow.flowsFromDeclaration(item).includes(nested))
  assert.ok(flow.flowsFromDeclaration(alias).includes(selected))
  for (const publication of [itemPublication, selected, nested]) {
    const reference = flow.referencesToDeclaration(publication.target.declaration!).find(ts.isPropertyAccessExpression)
    assert.ok(reference)
    assert.equal(flow.targetOf(reference)?.declaration, publication.target.declaration)
  }
  assert.ok(!publications.some((write) => write.site.getText() === 'item: target'), 'assignment patterns are not object publications')
  assert.equal(flow.calls.length, 0)
})

test('property writes retain their physical address across cell projections', () => {
  const entry = resolve('test/fixtures/property-write-address-inventory.ts')
  const source = `declare const key: string;
    declare const value: unknown;
    const receiver: Record<string, unknown> = {};
    receiver.named = value;
    receiver['literal'] = value;
    receiver[key] = value;`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const assignments = flow.allWrites.filter(
    (write) => ts.isBinaryExpression(write.site) && write.site.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
  const named = assignments.filter((write) => write.site.getText(file) === 'receiver.named = value')
  const literal = assignments.filter((write) => write.site.getText(file) === "receiver['literal'] = value")
  const computed = assignments.filter((write) => write.site.getText(file) === 'receiver[key] = value')
  assert.equal(named.length, 2)
  assert.equal(literal.length, 2)
  assert.equal(computed.length, 1)
  for (const writes of [named, literal]) {
    const access = (writes[0]!.site as ts.BinaryExpression).left
    assert.ok(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
    assert.ok(writes.every((write) => write.propertyAccess === access))
  }
  const computedAddress = (computed[0]!.site as ts.BinaryExpression).left
  assert.ok(ts.isElementAccessExpression(computedAddress))
  assert.equal(computed[0]!.slot, 'element')
  assert.equal(computed[0]!.naming?.getText(file), 'receiver')
  assert.equal(computed[0]!.propertyAccess, computedAddress)
})

test('prototype setter literals remain distinct from computed and shorthand data publications', () => {
  const entry = resolve('test/fixtures/prototype-publication-inventory.js')
  const source = `const object = {}; const __proto__ = object;
    const inherited = { __proto__: object };
    const quoted = { '__proto__': object };
    const computed = { ['__proto__']: object };
    const shorthand = { __proto__ };`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const prototypes = flow.allWrites.filter((write) => write.edge === 'prototype-assignment')
  assert.equal(prototypes.length, 2)
  assert.ok(prototypes.every((write) => write.slot === 'bulk' && write.target.declaration === null))
  const data = flow.allWrites.filter((write) => write.edge === 'property-assignment' && write.slot === 'whole')
  assert.deepEqual(
    data.map((write) => write.site.getText()),
    ["['__proto__']: object", '__proto__']
  )
  const object = (file.statements[0] as ts.VariableStatement).declarationList.declarations[0]!
  assert.ok(prototypes.every((write) => flow.flowsFromDeclaration(object).includes(write)))
})

test('explicit call/apply frames keep thisArg separate from ordinary arguments', () => {
  const entry = resolve('test/fixtures/explicit-this-operand-frame.ts')
  const source = `function take(this: any, first: number, second?: number) {}
    const receiver = {};
    take.call(receiver, 1, 2);
    take.apply(receiver, [3, 4]);
    take.call(undefined, 5);
    take.call();`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const frames = flow.calls.flatMap((site) => {
    if (!ts.isCallExpression(site.call)) return []
    return [
      {
        callee: site.operands.callee.getText(),
        receiver: site.operands.receiver?.getText() ?? null,
        args: site.operands.args.map((argument) => argument.getText())
      }
    ]
  })
  assert.deepEqual(frames, [
    { callee: 'take', receiver: 'receiver', args: ['1', '2'] },
    { callee: 'take', receiver: 'receiver', args: ['3', '4'] },
    { callee: 'take', receiver: 'undefined', args: ['5'] },
    { callee: 'take', receiver: null, args: [] }
  ])
  assert.ok(flow.calls.every((site) => site.operands.kind === 'call' && site.operands.explicitThis))
  assert.ok(flow.calls.every((site) => site.operands.dispatch.kind === 'direct'))
  assert.equal(flow.calls[0]?.operands.receiver?.getText(), 'receiver')
  assert.deepEqual(
    flow.calls[0]?.operands.args.map((argument) => argument.getText()),
    ['1', '2']
  )
})

test('indexed calls publish one normalized operand frame for calls, constructors and super', () => {
  const entry = resolve('test/fixtures/general-invocation-operands.ts')
  const source = `function free(value: number) {}
    const receiver = { run(value: number) {} };
    class Base { constructor(value: number) {} }
    class Derived extends Base { constructor() { super(4) } }
    free(1); receiver.run(2); new Base(3); new Derived();`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const indexed = flow.calls.map((site) => ({
    kind: site.operands.kind,
    dispatch: site.operands.dispatch.kind,
    lookup: site.operands.dispatch.kind === 'member' ? site.operands.dispatch.lookup.getText() : null,
    key: site.operands.dispatch.kind === 'member' ? site.operands.dispatch.key : null,
    explicitThis: site.operands.explicitThis,
    callee: site.operands.callee.getText(),
    receiver: site.operands.receiver?.getText() ?? null,
    args: site.operands.args.map((argument) => argument.getText())
  }))
  assert.deepEqual(indexed, [
    {
      kind: 'super',
      dispatch: 'super-constructor',
      lookup: null,
      key: null,
      explicitThis: false,
      callee: 'super',
      receiver: null,
      args: ['4']
    },
    { kind: 'call', dispatch: 'direct', lookup: null, key: null, explicitThis: false, callee: 'free', receiver: null, args: ['1'] },
    {
      kind: 'call',
      dispatch: 'member',
      lookup: 'receiver',
      key: 'run',
      explicitThis: false,
      callee: 'receiver.run',
      receiver: 'receiver',
      args: ['2']
    },
    { kind: 'construct', dispatch: 'direct', lookup: null, key: null, explicitThis: false, callee: 'Base', receiver: null, args: ['3'] },
    { kind: 'construct', dispatch: 'direct', lookup: null, key: null, explicitThis: false, callee: 'Derived', receiver: null, args: [] }
  ])
})

test('invocation dispatch preserves lexical super homes and unsupported lookup details', () => {
  const entry = resolve('test/fixtures/lexical-super-invocation-operands.ts')
  const source = `class Base {
      copy(value: number) {}
      static staticCopy(value: number) {}
      constructor(value: number) {}
    }
    class Derived extends Base {
      field = super.copy(1)
      static staticField = super.staticCopy(2)
      constructor() { const initialize = () => super(3); initialize() }
      run(key: string) {
        super.copy(4)
        super['copy'](5)
        super[key](6)
        const nested = () => super.copy(7)
        nested()
        super.copy.call(this, 8)
        super.copy.apply(this, [9])
        class Nested { [super.copy(12)]() {} }
      }
      static runStatic() { super.staticCopy(9) }
      static { super.staticCopy(10) }
    }
    const object = { run() { return super.toString() } }
    function unsupported() { return super.copy(11) }`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const describe = (site: (typeof flow.calls)[number]) => {
    const dispatch = site.operands.dispatch
    return {
      call: site.call.getText(file),
      kind: site.operands.kind,
      dispatch: dispatch.kind,
      lookup: dispatch.kind === 'member' ? dispatch.lookup.getText(file) : null,
      key: dispatch.kind === 'member' || dispatch.kind === 'lexical-super' ? dispatch.key : null,
      home:
        dispatch.kind === 'lexical-super' || dispatch.kind === 'super-constructor'
          ? dispatch.home && ts.isClassLike(dispatch.home)
            ? (dispatch.home.name?.text ?? '(anonymous class)')
            : dispatch.home
              ? '(object literal)'
              : null
          : null,
      static: dispatch.kind === 'lexical-super' ? dispatch.static : null,
      explicitThis: site.operands.explicitThis,
      receiver: site.operands.receiver?.getText(file) ?? null
    }
  }
  const descriptors = flow.calls.map(describe)
  const lexical = descriptors.filter((entry) => entry.dispatch === 'lexical-super')
  assert.deepEqual(
    lexical.map(({ call, key, home, static: staticLookup, explicitThis, receiver }) => ({
      call,
      key,
      home,
      staticLookup,
      explicitThis,
      receiver
    })),
    [
      { call: 'super.copy(1)', key: 'copy', home: 'Derived', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: 'super.staticCopy(2)', key: 'staticCopy', home: 'Derived', staticLookup: true, explicitThis: false, receiver: 'super' },
      { call: 'super.copy(4)', key: 'copy', home: 'Derived', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: "super['copy'](5)", key: 'copy', home: 'Derived', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: 'super[key](6)', key: null, home: 'Derived', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: 'super.copy(7)', key: 'copy', home: 'Derived', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: 'super.copy.call(this, 8)', key: 'copy', home: 'Derived', staticLookup: false, explicitThis: true, receiver: 'this' },
      { call: 'super.copy.apply(this, [9])', key: 'copy', home: 'Derived', staticLookup: false, explicitThis: true, receiver: 'this' },
      { call: 'super.copy(12)', key: 'copy', home: 'Derived', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: 'super.staticCopy(9)', key: 'staticCopy', home: 'Derived', staticLookup: true, explicitThis: false, receiver: 'super' },
      { call: 'super.staticCopy(10)', key: 'staticCopy', home: 'Derived', staticLookup: true, explicitThis: false, receiver: 'super' },
      { call: 'super.toString()', key: 'toString', home: '(object literal)', staticLookup: false, explicitThis: false, receiver: 'super' },
      { call: 'super.copy(11)', key: 'copy', home: null, staticLookup: false, explicitThis: false, receiver: 'super' }
    ]
  )
  const superConstructor = descriptors.find((entry) => entry.call === 'super(3)')
  assert.deepEqual(superConstructor, {
    call: 'super(3)',
    kind: 'super',
    dispatch: 'super-constructor',
    lookup: null,
    key: null,
    home: 'Derived',
    static: null,
    explicitThis: false,
    receiver: null
  })
})

test('receiver references retain lexical arrows, class initializer owners and computed-name outer evaluation', () => {
  const entry = resolve('test/fixtures/receiver-reference-inventory.js')
  const source = `function outer() {
    const lexical = () => this.lexical;
    function inner() { return this.inner }
    class Nested {
      [this.methodName]() { return this.methodBody }
      [this.fieldName] = () => this.fieldValue;
      static { this.staticValue }
    }
    return this.direct;
  }`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const outer = file.statements[0] as ts.FunctionDeclaration
  const inner = outer.body!.statements.find(ts.isFunctionDeclaration)!
  const nested = outer.body!.statements.find(ts.isClassDeclaration)!
  const mentions = (node: ts.Node) => flow.receiverReferencesToDeclaration(node).map((reference) => reference.parent.getText())
  assert.deepEqual(mentions(outer), ['this.lexical', 'this.methodName', 'this.fieldName', 'this.direct'])
  assert.deepEqual(mentions(inner), ['this.inner'])
  assert.deepEqual(mentions(nested.members.find(ts.isMethodDeclaration)!), ['this.methodBody'])
  assert.deepEqual(mentions(nested.members.find(ts.isPropertyDeclaration)!), ['this.fieldValue'])
  assert.deepEqual(mentions(nested.members.find(ts.isClassStaticBlockDeclaration)!), ['this.staticValue'])
  for (const owner of [
    outer,
    inner,
    nested.members.find(ts.isMethodDeclaration)!,
    nested.members.find(ts.isPropertyDeclaration)!,
    nested.members.find(ts.isClassStaticBlockDeclaration)!
  ])
    for (const reference of flow.receiverReferencesToDeclaration(owner)) assert.equal(flow.receiverOwnerOf(reference), owner)
  const computedNameReference = flow
    .receiverReferencesToDeclaration(outer)
    .find((reference) => reference.parent.getText() === 'this.methodName')!
  assert.equal(flow.receiverOwnerOf(computedNameReference), outer, 'computed member names execute in the enclosing receiver frame')
})

test('super lookups and constructor calls are indexed as lexical receiver uses', () => {
  const entry = resolve('test/fixtures/super-receiver-inventory.ts')
  const source = `class Base {
      constructor(value?: unknown) {}
      leak() { return this }
    }
    class Derived extends Base {
      constructor() { const initialize = () => super(); initialize(); this.ready() }
      ready() {}
      expose() { return super.leak() }
      nested() { return (() => super.leak.call(this))() }
    }`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const derived = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Derived')!
  assert.ok(ts.isClassDeclaration(derived))
  const constructor = derived.members.find(ts.isConstructorDeclaration)!
  const expose = derived.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(file) === 'expose')!
  const nested = derived.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(file) === 'nested')!
  const base = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Base')!
  assert.ok(ts.isClassDeclaration(base))
  const leak = base.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(file) === 'leak')!
  const mentions = (node: ts.Node) => flow.receiverReferencesToDeclaration(node).map((reference) => reference.getText(file))
  assert.deepEqual(mentions(constructor), ['super', 'this'])
  assert.deepEqual(mentions(expose), ['super'])
  assert.deepEqual(mentions(nested), ['super', 'this'])
  assert.deepEqual(mentions(leak), ['this'])
})

test('return inventory records bare completions under their nearest callable owner', () => {
  const entry = resolve('test/fixtures/bare-return-inventory.ts')
  const source = `function outer(choice: boolean) {
      if (choice) return;
      function inner() { return 1 }
    }`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const outer = file.statements.find(ts.isFunctionDeclaration)!
  const inner = outer.body!.statements.find(ts.isFunctionDeclaration)!
  const outerReturns = flow.writesToDeclaration(outer).filter((write) => write.edge === 'return')
  const innerReturns = flow.writesToDeclaration(inner).filter((write) => write.edge === 'return')
  assert.equal(outerReturns.length, 1)
  assert.equal(outerReturns[0]?.value, null)
  assert.ok(outerReturns[0]?.site && ts.isReturnStatement(outerReturns[0].site) && !outerReturns[0].site.expression)
  assert.equal(innerReturns.length, 1)
  assert.equal(innerReturns[0]?.value?.getText(file), '1')
})

test('writes through anonymous heap receivers remain in the shared flow inventory', () => {
  const entry = resolve('test/fixtures/anonymous-heap-write-inventory.ts')
  const source = `
    declare const key: string;
    declare const tree: any;
    tree[key].payload = globalThis;
    class Writer {
      write(key: string, value: unknown) { this[key] = value }
    }
  `
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const nested = flow.allWrites.find((write) => write.slot === 'member' && write.member === 'payload')
  assert.ok(nested)
  assert.equal(nested.naming?.getText(), 'tree[key]')
  assert.equal(nested.value?.getText(), 'globalThis')
  assert.equal(nested.target.declaration, null)
  const instance = flow.allWrites.find((write) => write.slot === 'element' && write.naming?.kind === ts.SyntaxKind.ThisKeyword)
  assert.ok(instance)
  assert.equal(instance.value?.getText(), 'value')
  assert.equal(instance.target.declaration, null)
})

test('pruned member calls and writes cannot poison live parameter evidence', () => {
  const entry = resolve('test/fixtures/pruned-member-evidence.js')
  const source = `
    function sink(value) { return value }
    let cell = { color: 1 };
    class Used {
      dead(value) { cell = value; sink(value) }
      live() { return 1 }
    }
    new Used().live();
    sink(cell);
  `
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, checkJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const reachable = censusReachability({ checker, files: [file], entries: [file] })
  const owner = file.statements.find(ts.isClassDeclaration)!
  const dead = owner.members.find((member) => member.name?.getText() === 'dead')!
  const live = owner.members.find((member) => member.name?.getText() === 'live')!
  assert.equal(reachable.memberIsPruned(dead), true)
  const flow = indexValueFlow(checker, [file], reachable)
  assert.equal(flow.callableBodyIsIndexed(dead), false)
  assert.equal(flow.callableBodyIsIndexed(live), true)
  assert.ok(flow.calls.some(({ call }) => call.getText() === 'sink(cell)'))
  assert.ok(!flow.calls.some(({ call }) => call.getText() === 'sink(value)'))
  assert.ok(!flow.allWrites.some((write) => write.site.getText() === 'cell = value'))
  const parameter = file.statements.find(ts.isFunctionDeclaration)!.parameters[0]!
  const census = censusParameterBindings(checker, [file], reachable)
  const type = census.typeAt(parameter)
  assert.ok(type && checker.getPropertyOfType(type, 'color'), 'the live caller must retain its complete color record')

  // The same unknown caller remains real evidence when its member is live.
  const unpruned = censusParameterBindings(checker, [file], wholeProgram)
  const unprunedType = unpruned.typeAt(parameter)
  assert.ok(unprunedType === null || (unprunedType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
})

test('property access inventory includes reachable reads and writes once, including nested bodies', () => {
  const entry = resolve('test/fixtures/property-access-inventory.ts')
  const source = `declare const key: string;
    const holder: Record<string, unknown> = {};
    class Subject {
      live() {
        holder.dotRead;
        holder['bracketRead'];
        holder.dotWrite = 1;
        holder[key] = 2;
        const nested = () => { holder.nestedDot; holder['nestedBracket'] = 3 };
        nested();
      }
      dead() { holder.dead }
    }
    new Subject().live();`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const reachable = censusReachability({ checker, files: [file], entries: [file] })
  const flow = indexValueFlow(checker, [file], reachable)
  const holderAccesses = flow.propertyAccesses.filter((access) => access.expression.getText(file) === 'holder')
  assert.deepEqual(
    holderAccesses.map((access) => access.getText(file)),
    ['holder.dotRead', "holder['bracketRead']", 'holder.dotWrite', 'holder[key]', 'holder.nestedDot', "holder['nestedBracket']"]
  )
  assert.equal(new Set(flow.propertyAccesses).size, flow.propertyAccesses.length)
  assert.ok(!holderAccesses.some((access) => access.getText(file) === 'holder.dead'))
})

test('source call argument edges skip the erased receiver and retain the rest tail', () => {
  const entry = resolve('test/fixtures/source-call-frame.ts')
  const source = 'function write(this: object, value: object, ...tail: object[]) {} write.call({}, globalThis, Date.prototype);'
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const declaration = file.statements[0] as ts.FunctionDeclaration
  const call = (file.statements[1] as ts.ExpressionStatement).expression as ts.CallExpression
  const flow = indexValueFlow(
    program.getTypeChecker(),
    [file],
    wholeProgram,
    undefined,
    () => declaration,
    () => [declaration]
  )
  assert.deepEqual(flow.writesToDeclaration(declaration.parameters[0]!), [])
  assert.deepEqual(
    flow.writesToDeclaration(declaration.parameters[1]!).map((write) => write.value),
    [call.arguments[1]]
  )
  assert.deepEqual(
    flow.writesToDeclaration(declaration.parameters[2]!).map((write) => [write.edge, write.value]),
    [['rest-argument', call.arguments[2]]]
  )
})

test('globalThis publication excludes script lexical class, let and const bindings', () => {
  const entry = resolve('test/fixtures/global-this-runtime-inventory.ts')
  const source = `class Writer {}; let local = 1; const fixed = 2;
    var runtime = 3; function callable() {} globalThis;`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const declaration = (name: string) =>
    file.statements
      .flatMap((statement) => (ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []))
      .find((candidate) => candidate.name.getText() === name)!
  const writer = file.statements.find(ts.isClassDeclaration)!
  const callable = file.statements.find(ts.isFunctionDeclaration)!
  const globalThisReference = file.statements.flatMap((statement) => {
    const values: ts.Identifier[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'globalThis') values.push(node)
      ts.forEachChild(node, visit)
    }
    visit(statement)
    return values
  })[0]!
  assert.ok(!flow.referencesToDeclaration(writer).includes(globalThisReference))
  assert.ok(!flow.referencesToDeclaration(declaration('local')).includes(globalThisReference))
  assert.ok(!flow.referencesToDeclaration(declaration('fixed')).includes(globalThisReference))
  assert.ok(flow.referencesToDeclaration(declaration('runtime')).includes(globalThisReference))
  assert.ok(flow.referencesToDeclaration(callable).includes(globalThisReference))
})

test('a JavaScript expando receiver keeps inherited methods separate from its export identities', () => {
  const entry = resolve('test/fixtures/expando-receiver-inventory.js')
  const source = `class Base { hook() {} untouched() {} }
    const object = new Base(); object.hook = function() {};
    function consume(value) {} consume(object);`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const owner = file.statements.find(ts.isClassDeclaration)!
  const variable = file.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!
  const call = (file.statements.at(-1) as ts.ExpressionStatement).expression as ts.CallExpression
  const argument = call.arguments[0]!
  const symbol = checker.getSymbolAtLocation(variable.name)!
  assert.ok((symbol.flags & ts.SymbolFlags.Module) !== 0, 'JS expando symbols carry a namespace flag')
  assert.ok(flow.referencesToDeclaration(variable).includes(argument))
  for (const method of owner.members) assert.ok(!flow.referencesToDeclaration(method).includes(argument))
  const exported = checker.getExportsOfModule(symbol).find((value) => value.name === 'hook')!
  assert.ok(flow.referencesToDeclaration(exported.valueDeclaration!).includes(argument), 'the actual expando identity remains exposed')
})

test('iteration bindings retain their iterable origin while preserving existence-only values', () => {
  const entry = resolve('test/fixtures/iteration-origin-inventory.ts')
  const source = `
    declare const items: Iterable<number>;
    declare const record: Record<string, number>;
    declare const stream: AsyncIterable<number>;
    let assigned = 0;
    function collect() {
      for (const value of items) void value;
      for (const key in record) void key;
      for (assigned of items) void assigned;
      for (const [first] of items) void first;
    }
    async function collectAsync() {
      for await (const value of stream) void value;
    }
  `
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(program.getTypeChecker(), [file], wholeProgram)
  const writes = flow.allWrites.filter((write) => write.edge === 'iteration-binding')
  const declaration = writes.find((write) => write.naming?.getText() === 'value' && write.iterationOrigin?.source.getText() === 'items')!
  const keys = writes.find((write) => write.naming?.getText() === 'key')!
  const assignment = writes.find((write) => write.naming?.getText() === 'assigned')!
  const asynchronous = writes.find((write) => write.iterationOrigin?.asynchronous)!
  assert.ok(declaration && keys && assignment && asynchronous)
  assert.equal(declaration.value, null)
  assert.deepEqual(
    [declaration.iterationOrigin?.source.getText(), declaration.iterationOrigin?.mode, declaration.iterationOrigin?.asynchronous],
    ['items', 'values', false]
  )
  assert.deepEqual(
    [keys.iterationOrigin?.source.getText(), keys.iterationOrigin?.mode, keys.iterationOrigin?.asynchronous],
    ['record', 'keys', false]
  )
  assert.deepEqual(
    [assignment.iterationOrigin?.source.getText(), assignment.iterationOrigin?.mode, assignment.iterationOrigin?.asynchronous],
    ['items', 'values', false]
  )
  assert.deepEqual(
    [asynchronous.iterationOrigin?.source.getText(), asynchronous.iterationOrigin?.mode, asynchronous.iterationOrigin?.asynchronous],
    ['stream', 'values', true]
  )
  assert.ok(!writes.some((write) => write.naming?.getText() === 'first' && write.iterationOrigin))
})

test('module namespace publication retains exported runtime values and excludes types', () => {
  const entry = resolve('test/fixtures/namespace-runtime-inventory.ts')
  const dependency = resolve('test/fixtures/namespace-runtime-dependency.ts')
  const source = `import * as namespace from './namespace-runtime-dependency.js';
    declare function consume(value: unknown): void; consume(namespace);`
  const exported = `export class Writer {} export function callable() {} export type OnlyType = { value: number }`
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)
  host.fileExists = (name) => resolve(name) === resolve(entry) || resolve(name) === resolve(dependency) || originalFileExists(name)
  host.getSourceFile = (name, version, ...rest) => {
    if (resolve(name) === resolve(entry)) return ts.createSourceFile(name, source, version, true)
    if (resolve(name) === resolve(dependency)) return ts.createSourceFile(name, exported, version, true)
    return original(name, version, ...rest)
  }
  const program = ts.createProgram([entry, dependency], options, host)
  const checker = program.getTypeChecker()
  const entryFile = program.getSourceFile(entry)!
  const dependencyFile = program.getSourceFile(dependency)!
  assert.ok(entryFile && dependencyFile)
  const flow = indexValueFlow(checker, [entryFile, dependencyFile], wholeProgram)
  const writer = dependencyFile.statements.find(ts.isClassDeclaration)!
  const callable = dependencyFile.statements.find(ts.isFunctionDeclaration)!
  const type = dependencyFile.statements.find(ts.isTypeAliasDeclaration)!
  const namespaceReference = entryFile.statements
    .flatMap((statement) => {
      const values: ts.Identifier[] = []
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'namespace' && ts.isCallExpression(node.parent) && node.parent.expression !== node)
          values.push(node)
        ts.forEachChild(node, visit)
      }
      visit(statement)
      return values
    })
    .find((node) => node.parent.kind === ts.SyntaxKind.CallExpression)!
  assert.ok(flow.referencesToDeclaration(writer).includes(namespaceReference))
  assert.ok(flow.referencesToDeclaration(callable).includes(namespaceReference))
  assert.ok(!flow.referencesToDeclaration(type).includes(namespaceReference))
})
