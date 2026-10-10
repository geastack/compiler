import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { indexValueFlow } from './value-flow.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { createStructuralMapper } from '../structural.js'
import { createIdentityTable } from '../identities.js'
import { createStructuralTypeTable } from '../../model/structural-type-table.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { sourceIntrinsicMemberInvocationOf } from './source-intrinsic-member-data.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-value-session.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: false, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  // Production always attaches a ledger: an element read off an array literal
  // and a `for-in` head both defer an intrinsic obligation to it, and refuse
  // with nothing to carry the obligation.
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const session = sourceValueSessionOf(checker, flow)
  const targetCall = (marker: string, callee: string): ts.CallExpression => {
    const markerAt = file.text.indexOf(marker)
    assert.notEqual(markerAt, -1, `missing marker ${marker}`)
    const start = markerAt + marker.length
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.getStart(file) >= start && node.expression.getText(file) === callee) calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(file)
    calls.sort((left, right) => left.getStart(file) - right.getStart(file))
    assert.ok(calls[0], `missing ${callee} call after ${marker}`)
    return calls[0]
  }
  const bodyTexts = (call: ts.CallExpression): string[] | null =>
    ledger
      .capture(() => session.invocationTargetsOf(call))
      .value?.map((body) => body.getText(file))
      .sort() ?? null
  return { bodyTexts, checker, file, flow, ledger, program, session, targetCall }
}

test('closed unchanged formal frames preserve actual native source expressions before value expansion', () => {
  const checked = inspect(`
    function attempt(obj, key: 'name' | 'length') { obj[key] = 7 }
    const original = Date.prototype.getTime
    attempt(original, 'name')
  `)
  const body = checked.file.statements.find(ts.isFunctionDeclaration)!
  const owner = body.parameters[0]!
  const key = body.parameters[1]!
  assert.ok(checked.ledger.capture(() => checked.session.parameterValuesOf(owner)).value === null)
  const actuals = (parameter: ts.ParameterDeclaration) =>
    checked.ledger.capture(() => checked.session.parameterSourceExpressionsOf(parameter)).value?.map((one) => one.getText(checked.file))
  assert.deepEqual(actuals(owner), ['original'])
  assert.deepEqual(actuals(key), ["'name'"])
})

test('actual formal source projection refuses missing, rebound, default, rest and published frames', () => {
  for (const source of [
    'function attempt(obj) { void obj } attempt();',
    'function attempt(obj) { obj = Date.prototype.getUTCFullYear; void obj } attempt(Date.prototype.getTime);',
    'function attempt(obj = Date.prototype.getTime) { void obj } attempt();',
    'function attempt(...obj) { void obj } attempt(Date.prototype.getTime);',
    'declare function opaque(value: unknown): void; function attempt(obj) { void obj } opaque(attempt); attempt(Date.prototype.getTime);'
  ]) {
    const checked = inspect(source)
    const body = checked.file.statements.find(
      (one): one is ts.FunctionDeclaration => ts.isFunctionDeclaration(one) && one.body !== undefined
    )!
    assert.ok(checked.ledger.capture(() => checked.session.parameterSourceExpressionsOf(body.parameters[0]!)).value === null, source)
  }
})

test('selected actual source frames separate body copies without hiding shared root writers', () => {
  const checked = inspect(`
    function merge<T extends object>(input: T) { /* copy */ return Object.assign({ label: 'held' }, input) }
    const original = { context: 'initial' };
    /* first */ const first = merge(original);
    /* second */ const second = merge({});
    original.context = 'later';
    Object.keys(first); Object.keys(second);
  `)
  const copy = checked.targetCall('/* copy */', 'Object.assign')
  const first = checked.targetCall('/* first */', 'merge')
  const second = checked.targetCall('/* second */', 'merge')
  const body = ts.findAncestor(copy, ts.isFunctionLike)!
  const held = checked.ledger.capture(() => checked.session.ownAssignmentOf(copy, { body, callers: [first] })).value
  const empty = checked.ledger.capture(() => checked.session.ownAssignmentOf(copy, { body, callers: [second] })).value
  assert.ok(held)
  assert.ok(empty)
  assert.equal(held.sources[0]!.roots.length, 1)
  assert.deepEqual(
    held.sources[0]!.roots[0]!.slots.find((slot) => slot.key === 'context')!.values.map((value) => value.getText(checked.file)),
    ["'initial'", "'later'"]
  )
  assert.equal(empty.sources[0]!.roots.length, 1)
  assert.deepEqual(empty.sources[0]!.roots[0]!.slots, [])
})

test('selected source frames still reject foreign entries and opaque allocation aliases', () => {
  for (const effect of ['', 'declare function publish(value: unknown): void; publish(original);']) {
    const checked = inspect(`
      function merge<T extends object>(input: T) { /* copy */ return Object.assign({ label: 'held' }, input) }
      const original = { context: 'initial' };
      /* first */ const first = merge(original);
      /* foreign */ Object.keys(first);
      ${effect}
    `)
    const copy = checked.targetCall('/* copy */', 'Object.assign')
    const first = checked.targetCall('/* first */', 'merge')
    const foreign = checked.targetCall('/* foreign */', 'Object.keys')
    const body = ts.findAncestor(copy, ts.isFunctionLike)!
    assert.ok(checked.ledger.capture(() => checked.session.ownAssignmentOf(copy, { body, callers: [foreign] })).value === null)
    if (effect !== '')
      assert.ok(checked.ledger.capture(() => checked.session.ownAssignmentOf(copy, { body, callers: [first] })).value === null)
  }
})

/** The first expression after `marker` whose own text is exactly `text` -- the
 * non-call sibling of `targetCall` above, for a plain property read rather
 * than an invocation. */
const targetExpression = (file: ts.SourceFile, marker: string, text: string): ts.Expression => {
  const markerAt = file.text.indexOf(marker)
  assert.notEqual(markerAt, -1, `missing marker ${marker}`)
  const start = markerAt + marker.length
  const matches: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node) && node.getStart(file) >= start && node.getText(file) === text) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  matches.sort((left, right) => left.getStart(file) - right.getStart(file))
  assert.ok(matches[0], `missing ${text} after ${marker}`)
  return matches[0]!
}

test('direct native slots retain all actual writers through closed fields and source frames', () => {
  const checked = inspect(`
    class Holder { held: { value?: string }; constructor(value: { value?: string }) { this.held = value; } }
    function keep(value: { value?: string }) { return new Holder(value); }
    const original = {} as { value?: string };
    const holder = keep(original);
    holder.held.value = 'updated';
    /* target */ original.value;
  `)
  const expression = targetExpression(checked.file, '/* target */', 'original')
  const captured = checked.ledger.capture(() => checked.session.ownSlotOf(expression, 'value'))
  assert.ok(captured.value)
  assert.equal(captured.value.roots.length, 1)
  assert.deepEqual(
    captured.value.roots[0]!.values.map((value) => value.getText(checked.file)),
    ["'updated'"]
  )
  assert.deepEqual(
    captured.value.roots[0]!.writes.map((write) => write.getText(checked.file)),
    ['holder.held.value']
  )
})

test('standard empty Object roots retain their exact native slot writers through closed aliases', () => {
  for (const construction of ['Object()', 'new Object()']) {
    const checked = inspect(`
      function write(value: { extra?: number }) { value.extra = 7; }
      const original = ${construction};
      write(original);
      /* target */ original.extra;
    `)
    const expression = targetExpression(checked.file, '/* target */', 'original')
    const proof = checked.ledger.capture(() => checked.session.ownSlotOf(expression, 'extra'))
    assert.ok(proof.value)
    assert.ok(proof.value.roots[0]!.root.getText(checked.file) === construction)
    assert.deepEqual(
      proof.value.roots[0]!.values.map((value) => value.getText(checked.file)),
      ['7']
    )
    assert.deepEqual(
      proof.value.roots[0]!.writes.map((write) => write.getText(checked.file)),
      ['value.extra']
    )
    assert.ok(proof.requirements.some((one) => one.intrinsic === 'Object' && one.member === 'prototype'))
  }
  const shadow = inspect(`const Object = () => ({}); const original = Object(); original.extra = 7; /* target */ original.extra;`)
  const shadowRoot = targetExpression(shadow.file, '/* target */', 'original')
  const shadowProof = shadow.ledger.capture(() => shadow.session.ownSlotOf(shadowRoot, 'extra')).value
  assert.ok(shadowProof)
  assert.ok(ts.isObjectLiteralExpression(shadowProof.roots[0]!.root), 'the shadowed call retains its actual source literal')
  for (const escape of ['publish(Object)', 'publish(Object())']) {
    const checked = inspect(`
      declare function publish(value: unknown): void;
      const Object = () => ({});
      const original = Object(); original.extra = 7;
      ${escape}; /* target */ original.extra;
    `)
    const owner = targetExpression(checked.file, '/* target */', 'original')
    assert.ok(checked.ledger.capture(() => checked.session.ownSlotOf(owner, 'extra')).value === null)
  }
  const escaped = inspect(
    `declare function publish(value: unknown): void; const original = Object(); original.extra = 7; publish(original); /* target */ original.extra;`
  )
  const escapedRoot = targetExpression(escaped.file, '/* target */', 'original')
  assert.ok(escaped.ledger.capture(() => escaped.session.ownSlotOf(escapedRoot, 'extra')).value === null)
})

test('direct native slot closure accounts exact Object.keys iteration without publishing the owner', () => {
  const checked = inspect(`
    function inspect(value: { [key: string]: unknown }) {
      for (const key of Object.keys(value)) void value[key];
    }
    const original = { first: 'initial' } as { first: string; extra?: number };
    inspect(original);
    original.extra = 5;
    /* target */ original.extra;
  `)
  const expression = targetExpression(checked.file, '/* target */', 'original')
  const captured = checked.ledger.capture(() => checked.session.ownSlotOf(expression, 'extra'))
  assert.ok(captured.value)
  assert.deepEqual(
    captured.value.roots[0]!.values.map((value) => value.getText(checked.file)),
    ['5']
  )
  assert.ok(captured.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.member === 'keys'))
})

test('direct native slots refuse an opaque consumer or descriptor replacement', () => {
  for (const effect of [
    'declare function publish(value: unknown): void; publish(original);',
    "Object.defineProperty(original, 'extra', { get() { return 5 } });"
  ]) {
    const checked = inspect(`const original = {} as { extra?: number }; original.extra = 5; ${effect} /* target */ original.extra;`)
    const expression = targetExpression(checked.file, '/* target */', 'original')
    assert.ok(checked.ledger.capture(() => checked.session.ownSlotOf(expression, 'extra')).value === null)
  }
})

test('fresh standard Object allocations participate in the same source slot inventory', () => {
  for (const expression of ['Object()', 'new Object()']) {
    const checked = inspect(`const original = ${expression}; original.extra = 5; /* target */ original.extra;`)
    const owner = targetExpression(checked.file, '/* target */', 'original')
    const roots = checked.ledger.capture(() => checked.session.valuesOf(owner))
    assert.ok(roots.value)
    assert.equal(roots.value.length, 1)
    assert.ok(roots.value[0]!.getText(checked.file) === expression)
    assert.ok(roots.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.member === 'prototype'))
  }
  const shadow = inspect(`const Object = () => ({}); const owner = Object(); /* target */ owner;`)
  const owner = targetExpression(shadow.file, '/* target */', 'owner')
  const roots = shadow.ledger.capture(() => shadow.session.valuesOf(owner)).value
  assert.ok(roots)
  assert.equal(roots[0]!.getText(shadow.file), '{}')
})

test('native literal iteration retains element escapes in the source closure', () => {
  const checked = inspect(`
    const original = {} as { extra?: number };
    original.extra = 5;
    const values = [original];
    declare function escape(value: unknown): void;
    for (const value of values) escape(value);
    /* target */ original.extra;
  `)
  const owner = targetExpression(checked.file, '/* target */', 'original')
  assert.ok(checked.ledger.capture(() => checked.session.ownSlotOf(owner, 'extra')).value === null)
})

/** The parameter of the first `set <key>(...)` accessor in the file. */
const setterParameterOf = (file: ts.SourceFile, key: string): ts.ParameterDeclaration => {
  let found: ts.ParameterDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isSetAccessorDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === key) found = node.parameters[0]
    else ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `missing setter ${key}`)
  return found!
}

/**
 * Some capabilities -- `Object.assign`, and any read that falls through to an
 * absent key -- raise a deferred intrinsic protocol obligation that only a
 * ledger discharges (`SourceValueSession`'s `admitted` refuses outright
 * without one). Attaching a ledger and capturing the whole query mirrors how
 * normalization itself authorizes these proofs (`computed-key-set.test.ts`),
 * and costs nothing extra for a query that raises no obligation at all.
 */
const withLedger = <T>(checked: { readonly flow: ReturnType<typeof inspect>['flow'] }, query: () => T): T => {
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(checked.flow, ledger)
  return ledger.capture(query).value
}

test('a Function own data replacement selects its actual ordinary source frame and extracted alias', () => {
  const checked = inspect(`
    function owner(value: string) { return value.length }
    function installed(this: any, first: string, second: string) { return this.name + first + second }
    Reflect.set(owner, 'call', installed);
    /* direct */ owner.call('first', 'second');
    const detached = owner.call as unknown as (first: string, second: string) => string;
    /* extracted */ detached('first', 'second');
  `)
  const direct = checked.targetCall('/* direct */', 'owner.call')
  const bodies = checked.bodyTexts(direct)
  assert.ok(bodies)
  assert.equal(bodies.length, 1)
  assert.match(bodies[0]!, /function installed/)
  const ledger = checked.ledger
  const entry = ledger.capture(() => checked.session.ordinaryOwnCallableOperandsOf(direct))
  assert.ok(entry.value)
  assert.equal(entry.value.explicitThis, false)
  assert.equal(entry.value.receiver?.getText(), 'owner')
  assert.deepEqual(
    entry.value.args.map((argument) => argument.getText()),
    ["'first'", "'second'"]
  )
  assert.ok(entry.requirements.some((requirement) => requirement.intrinsic === 'Function' && requirement.prototypeKeys !== undefined))
  assert.ok(
    entry.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.prototypeAbsentNames?.includes('call'))
  )
  const extracted = checked.bodyTexts(checked.targetCall('/* extracted */', 'detached'))
  assert.deepEqual(extracted, bodies)
})

test('Function own source closure refuses exposure, rebinding and installs not executed before the read', () => {
  const setup = `function owner(value: string) { return value.length }; function installed(first: string) { return first };`
  for (const suffix of [
    `declare function external(value: unknown): void; Reflect.set(owner, 'call', installed); external(owner);`,
    `declare const external: typeof owner; owner = external; Reflect.set(owner, 'call', installed);`,
    `declare const flag: boolean; if (flag) Reflect.set(owner, 'call', installed);`,
    `declare const flag: boolean; flag && Reflect.set(owner, 'call', installed);`,
    `declare const flag: boolean; while (flag) Reflect.set(owner, 'call', installed);`
  ]) {
    const checked = inspect(`${setup} ${suffix} /* target */ owner.call('first');`)
    assert.ok(checked.bodyTexts(checked.targetCall('/* target */', 'owner.call')) === null, suffix)
  }
  const before = inspect(`${setup} /* target */ owner.call('first'); Reflect.set(owner, 'call', installed);`)
  assert.ok(before.bodyTexts(before.targetCall('/* target */', 'owner.call')) === null)
  const destructured = inspect(`${setup} const { call: detached } = owner; Reflect.set(owner, 'call', installed); /* target */ detached();`)
  assert.ok(destructured.bodyTexts(destructured.targetCall('/* target */', 'detached')) === null)
  const hoisted = inspect(`${setup}
    invoke();
    Reflect.set(owner, 'call', installed);
    function invoke(value = /* target */ owner.call('first')) { return value }
  `)
  assert.ok(hoisted.bodyTexts(hoisted.targetCall('/* target */', 'owner.call')) === null)
})

test('the admitted installed body owns the structural result and complete ordinary invocation signature', () => {
  const checked = inspect(`
    function owner(value: string): number { return value.length }
    function installed(this: any, first: string, second: string): string { return this.name + first + second }
    Reflect.set(owner, 'call', installed);
    /* direct */ owner.call('first', 'second');
    const detached = owner.call as unknown as (only: string) => number;
    /* extracted */ detached('first');
  `)
  const table = createStructuralTypeTable()
  const mapper = createStructuralMapper(
    checked.checker,
    createIdentityTable(checked.program, checked.checker),
    table,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checked.flow
  )
  for (const call of [checked.targetCall('/* direct */', 'owner.call'), checked.targetCall('/* extracted */', 'detached')]) {
    const held = checked.ledger.capture(() => mapper.ordinaryOwnCallableInvocationAt(call))
    assert.ok(held.value)
    assert.equal(ts.getNameOfDeclaration(held.value.body)?.getText(), 'installed')
    assert.equal(held.value.frame.parameters.length, 2)
    assert.equal(held.value.frame.minimumArity, 2)
    assert.deepEqual(table.get(held.value.frame.thisParameter!).shape, { kind: 'primitive', primitive: 'any' })
    assert.deepEqual(table.get(held.value.frame.result).shape, { kind: 'primitive', primitive: 'string' })
    assert.ok(checked.ledger.capture(() => mapper.typeAt(call)).value === held.value.frame.result)
  }
})

test('a sealed source-body admission publishes the same own frame outside the provisional ledger capture', () => {
  const checked = inspect(`
    function owner(value: string): number { return value.length }
    function installed(this: any, first: string, second: string): string { return this.name + first + second }
    Reflect.set(owner, 'call', installed);
    /* direct */ owner.call('first', 'second');
    const detached = owner.call as unknown as (only: string) => number;
    /* extracted */ detached('first');
  `)
  let sealedAdmission = true
  const table = createStructuralTypeTable()
  const mapper = createStructuralMapper(
    checked.checker,
    createIdentityTable(checked.program, checked.checker),
    table,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checked.flow,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (call) => {
      const source = checked.ledger.capture(() => checked.session.ordinaryOwnCallableSourceOf(call))
      return sealedAdmission ? source.value : null
    }
  )
  for (const call of [checked.targetCall('/* direct */', 'owner.call'), checked.targetCall('/* extracted */', 'detached')]) {
    // Ordinary production/type lookups do not open a provisional capture.
    // The supplied authority has already captured/discharged its obligations.
    const frame = mapper.ordinaryOwnCallableInvocationAt(call)
    assert.ok(frame)
    assert.equal(frame.frame.minimumArity, 2)
    assert.deepEqual(table.get(frame.observedResult).shape, { kind: 'primitive', primitive: 'string' })
    assert.ok(mapper.typeAt(call) === frame.observedResult)
    sealedAdmission = false
    assert.ok(checked.ledger.capture(() => mapper.ordinaryOwnCallableInvocationAt(call)).value === null)
    sealedAdmission = true
  }
})

test('a native void own body publishes undefined from the same authenticated source frame', () => {
  const checked = inspect(`
    function owner(value: string): number { return value.length }
    function installed(first: string): void { first.length; }
    Reflect.set(owner, 'call', installed);
    /* direct */ owner.call('first');
  `)
  const table = createStructuralTypeTable()
  const mapper = createStructuralMapper(
    checked.checker,
    createIdentityTable(checked.program, checked.checker),
    table,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    checked.flow
  )
  const call = checked.targetCall('/* direct */', 'owner.call')
  const held = checked.ledger.capture(() => mapper.ordinaryOwnCallableInvocationAt(call)).value
  assert.ok(held)
  assert.deepEqual(table.get(held.frame.result).shape, { kind: 'primitive', primitive: 'void' })
  assert.deepEqual(table.get(held.observedResult).shape, { kind: 'primitive', primitive: 'undefined' })
  assert.ok(checked.ledger.capture(() => mapper.typeAt(call)).value === held.observedResult)
})

test('a Function own slot cannot borrow a supplied Reflect Receiver or an open key', () => {
  for (const installed of [
    `Reflect.set(owner, 'call', installed, {});`,
    `declare const key: string; Reflect.set(owner, key, installed);`,
    `(owner as any).__proto__ = {}; Reflect.set(owner, 'call', installed);`
  ]) {
    const checked = inspect(`function owner() {}; function installed() {}; ${installed} /* target */ owner.call();`)
    assert.ok(checked.bodyTexts(checked.targetCall('/* target */', 'owner.call')) === null)
  }
})

test('one source-value session resolves a receiver-field-method mutation cycle as a joint graph', () => {
  const checked = inspect(`
    class Owner {
      value = 4;
      slot = { run(owner) { return owner.value + 1 } };
    }
    const owner = new Owner();
    const alias = owner.slot;
    alias.run = function second(owner) { return owner.value + 2 };
    /* target */ owner.slot.run(owner);
  `)
  const bodies = checked.bodyTexts(checked.targetCall('/* target */', 'owner.slot.run'))
  assert.ok(bodies)
  assert.equal(bodies.length, 2)
  assert.ok(bodies.some((body) => body.includes('owner.value + 1')))
  assert.ok(bodies.some((body) => body.includes('owner.value + 2')))
})

test('source-value session refuses escaped receivers, escaped slots, and opaque slot replacement', () => {
  const base = `
    class Owner { value = 4; slot = { run(owner) { return owner.value + 1 } }; }
    const owner = new Owner();
    const alias = owner.slot;
    alias.run = function second(owner) { return owner.value + 2 };
  `
  const externalOwner = inspect(
    `${base} declare function external(value: unknown): void; external(owner); /* target */ owner.slot.run(owner);`
  )
  assert.ok(externalOwner.bodyTexts(externalOwner.targetCall('/* target */', 'owner.slot.run')) === null)

  const externalSlot = inspect(
    `${base} declare function external(value: unknown): void; external(owner.slot); /* target */ owner.slot.run(owner);`
  )
  assert.ok(externalSlot.bodyTexts(externalSlot.targetCall('/* target */', 'owner.slot.run')) === null)

  const opaqueSlot = inspect(`${base} declare function getSlot(): unknown; owner.slot = getSlot(); /* target */ owner.slot.run(owner);`)
  assert.ok(opaqueSlot.bodyTexts(opaqueSlot.targetCall('/* target */', 'owner.slot.run')) === null)
})

test('literal computed method replacement joins the graph; an unknown key refuses', () => {
  const literal = inspect(`
    class Owner { value = 4; slot = { run(owner) { return owner.value + 1 } }; }
    const owner = new Owner();
    const alias = owner.slot;
    const key = 'run';
    alias[key] = function second(owner) { return owner.value + 2 };
    /* target */ owner.slot.run(owner);
  `)
  const bodies = literal.bodyTexts(literal.targetCall('/* target */', 'owner.slot.run'))
  assert.ok(bodies)
  assert.equal(bodies.length, 2)
  assert.ok(bodies.some((body) => body.includes('owner.value + 1')))
  assert.ok(bodies.some((body) => body.includes('owner.value + 2')))

  const unknown = inspect(`
    class Owner { value = 4; slot = { run(owner) { return owner.value + 1 } }; }
    const owner = new Owner();
    const alias = owner.slot;
    declare function getKey(): string;
    alias[getKey()] = function second(owner) { return owner.value + 2 };
    /* target */ owner.slot.run(owner);
  `)
  assert.ok(unknown.bodyTexts(unknown.targetCall('/* target */', 'owner.slot.run')) === null)

  const opaqueFunction = inspect(`
    class Owner { value = 4; slot = { run(owner) { return owner.value + 1 } }; }
    const owner = new Owner();
    const alias = owner.slot;
    declare const unknownRun: (owner: Owner) => number;
    alias.run = unknownRun;
    /* target */ owner.slot.run(owner);
  `)
  assert.ok(opaqueFunction.bodyTexts(opaqueFunction.targetCall('/* target */', 'owner.slot.run')) === null)
})

test('source-value graph answers are stable when receiver and alias calls are queried in reverse order', () => {
  const source = `
    class Owner {
      value = 4;
      slot = { run(owner) { return owner.value + 1 } };
    }
    const owner = new Owner();
    const alias = owner.slot;
    alias.run = function second(owner) { return owner.value + 2 };
    /* owner call */ owner.slot.run(owner);
    /* alias call */ alias.run(owner);
  `
  const checked = inspect(source)
  const ownerCall = checked.targetCall('/* owner call */', 'owner.slot.run')
  const aliasCall = checked.targetCall('/* alias call */', 'alias.run')
  const expected = checked.bodyTexts(ownerCall)
  assert.ok(expected)
  assert.equal(expected.length, 2)
  assert.deepEqual(checked.bodyTexts(aliasCall), expected)

  // A fresh program/flow is required because source-value sessions are memoized per flow.
  const reversed = inspect(source)
  const reversedOwnerCall = reversed.targetCall('/* owner call */', 'owner.slot.run')
  const reversedAliasCall = reversed.targetCall('/* alias call */', 'alias.run')
  assert.deepEqual(reversed.bodyTexts(reversedAliasCall), expected)
  assert.deepEqual(reversed.bodyTexts(reversedOwnerCall), expected)
})

test('source-value origins follow local aliases, fields, factory completions, and array elements', () => {
  const checked = inspect(`
    class Owner {
      value = 4;
      slot = { run(owner) { return owner.value + 1 } };
    }
    function makeOwner() { return new Owner(); }
    const created = makeOwner();
    const alias = created;
    /* local alias */ alias.slot.run(alias);
    /* factory result */ created.slot.run(created);
    const items = [created];
    /* array element */ items[0].slot.run(items[0]);
  `)
  for (const [marker, callee] of [
    ['/* local alias */', 'alias.slot.run'],
    ['/* factory result */', 'created.slot.run'],
    ['/* array element */', 'items[0].slot.run']
  ] as const) {
    const bodies = checked.bodyTexts(checked.targetCall(marker, callee))
    assert.ok(bodies, marker)
    assert.equal(bodies.length, 1, marker)
    assert.ok(bodies[0]!.includes('owner.value + 1'), marker)
  }
})

test('typed structural aliases project the actual mutable source slot through the shared graph', () => {
  const checked = inspect(`
    class Owner { shown: string = 'initial'; }
    const owner = new Owner();
    const view: { shown: string | number } = owner;
    const chained = view;
    chained.shown = 7;
    /* owner */ owner;
    /* view */ view;
    /* chain */ chained;
  `)
  const members = (marker: string, name: string): readonly string[] | null =>
    withLedger(checked, () => checked.session.memberValuesOf(targetExpression(checked.file, marker, name), 'shown'))
      ?.map((value) => value.getText(checked.file))
      .sort() ?? null
  assert.deepEqual(members('/* owner */', 'owner'), ["'initial'", '7'])
  assert.deepEqual(members('/* view */', 'view'), ["'initial'", '7'])
  assert.deepEqual(members('/* chain */', 'chained'), ["'initial'", '7'])
})

test('a structural alias with an opaque mutation path cannot publish a complete field storage family', () => {
  const checked = inspect(`
    class Owner { shown: string = 'initial'; }
    const owner = new Owner();
    const view: { shown: string | number } = owner;
    declare function mutate(value: { shown: string | number }): void;
    mutate(view);
    /* owner */ owner;
  `)
  assert.ok(
    withLedger(checked, () => checked.session.memberValuesOf(targetExpression(checked.file, '/* owner */', 'owner'), 'shown')) === null
  )
})

test('source-value session handles inherited slots and refuses escaped construction', () => {
  const inherited = inspect(`
    class Base { slot = { run() { return 1 } }; }
    class Derived extends Base {}
    const owner = new Derived();
    /* inherited */ owner.slot.run();
  `)
  const inheritedBodies = inherited.bodyTexts(inherited.targetCall('/* inherited */', 'owner.slot.run'))
  assert.ok(inheritedBodies)
  assert.equal(inheritedBodies.length, 1)
  assert.ok(inheritedBodies[0]!.includes('return 1'))

  const escaped = inspect(`
    declare function external(value: unknown): void;
    class Base {
      slot = { run() { return 1 } };
      constructor() { external(this); }
    }
    class Derived extends Base {}
    const owner = new Derived();
    /* escaped construction */ owner.slot.run();
  `)
  assert.ok(escaped.bodyTexts(escaped.targetCall('/* escaped construction */', 'owner.slot.run')) === null)
})

test('constructor forwarding uses the derived frame callback instead of the raw new argument', () => {
  const checked = inspect(`
    class Base {
      slot: { run: () => number };
      constructor(callback: () => number) { this.slot = { run: callback }; }
    }
    class Derived extends Base {
      constructor(ignored: () => number) { super(() => 2); }
    }
    const owner = new Derived(() => 1);
    /* forwarded callback */ owner.slot.run();
  `)
  const bodies = checked.bodyTexts(checked.targetCall('/* forwarded callback */', 'owner.slot.run'))
  assert.ok(bodies)
  assert.equal(bodies.length, 1)
  assert.ok(bodies[0]!.includes('=> 2'))
  assert.ok(!bodies[0]!.includes('=> 1'))
})

test('default callback graph edges cover explicit, omitted, undefined, and mixed callers', () => {
  const explicit = inspect(`
    function make(callback: () => number = () => 2) { return { run: callback }; }
    const result = make(() => 1);
    /* explicit */ result.run();
  `)
  const explicitBodies = explicit.bodyTexts(explicit.targetCall('/* explicit */', 'result.run'))
  assert.ok(explicitBodies)
  assert.equal(explicitBodies.length, 1)
  assert.ok(explicitBodies[0]!.includes('=> 1'))
  assert.ok(!explicitBodies[0]!.includes('=> 2'))

  for (const [argument, marker] of [
    ['', '/* omitted */'],
    ['undefined', '/* undefined */']
  ] as const) {
    const checked = inspect(`
      function make(callback: () => number = () => 2) { return { run: callback }; }
      const result = make(${argument});
      ${marker} result.run();
    `)
    const bodies = checked.bodyTexts(checked.targetCall(marker, 'result.run'))
    assert.ok(bodies, marker)
    assert.equal(bodies.length, 1, marker)
    assert.ok(bodies[0]!.includes('=> 2'), marker)
    assert.ok(!bodies[0]!.includes('=> 1'), marker)
  }

  const mixed = inspect(`
    function make(callback: () => number = () => 2) { return { run: callback }; }
    const explicit = make(() => 1);
    const omitted = make();
    /* mixed caller */ explicit.run();
  `)
  const mixedBodies = mixed.bodyTexts(mixed.targetCall('/* mixed caller */', 'explicit.run'))
  assert.ok(mixedBodies)
  assert.equal(mixedBodies.length, 2)
  assert.ok(mixedBodies.some((body) => body.includes('=> 1')))
  assert.ok(mixedBodies.some((body) => body.includes('=> 2')))
})

test('invocation ownership stays with the existing explicit-this wrapper domain', () => {
  const checked = inspect(`
    interface Slot { run: () => number }
    class Owner { slot: Slot = { run() { return 1 } }; }
    const owner = new Owner();
    /* ordinary */ owner.slot.run();
    /* call wrapper */ owner.slot.run.call(null);
    /* apply wrapper */ owner.slot.run.apply(null, []);
  `)
  assert.equal(checked.session.ownsInvocation(checked.targetCall('/* ordinary */', 'owner.slot.run')), true)
  assert.equal(checked.session.ownsInvocation(checked.targetCall('/* call wrapper */', 'owner.slot.run.call')), false)
  assert.equal(checked.session.ownsInvocation(checked.targetCall('/* apply wrapper */', 'owner.slot.run.apply')), false)

  const escaped = inspect(`
    declare function external(value: unknown): void;
    interface Slot { run: () => number }
    class Owner { slot: Slot = { run() { return 1 } }; }
    const owner = new Owner();
    external(owner.slot);
    /* escaped ordinary */ owner.slot.run();
  `)
  const escapedCall = escaped.targetCall('/* escaped ordinary */', 'owner.slot.run')
  assert.equal(escaped.session.ownsInvocation(escapedCall), true)
  assert.ok(escaped.bodyTexts(escapedCall) === null)
})

test('call completion frames preserve distinct actuals, defaults, aliases and parameter writes', () => {
  const source = `
    function choose(callback = () => 2) { const alias = callback; return alias; }
    /* explicit */ choose(() => 1);
    /* omitted */ choose();
    /* undefined */ choose(undefined);
    function replace(callback) { callback = () => 3; return callback; }
    /* replaced */ replace(() => 4);
  `
  for (const reverse of [false, true]) {
    const checked = inspect(source)
    const cases = [
      ['/* explicit */', 'choose', ['() => 1']],
      ['/* omitted */', 'choose', ['() => 2']],
      ['/* undefined */', 'choose', ['() => 2']],
      ['/* replaced */', 'replace', ['() => 3', '() => 4']]
    ] as const
    for (const [marker, callee, expected] of reverse ? [...cases].reverse() : cases) {
      const call = checked.targetCall(marker, callee)
      const values = checked.session.valuesOf(call)
      assert.ok(values, marker)
      assert.deepEqual(values.map((value) => value.getText(checked.file)).sort(), expected, marker)
    }
  }
})

test('per-call receivers and synchronous undefined completions remain explicit graph values', () => {
  const checked = inspect(`
    const receiver = function () { return this; };
    const left = { read: receiver };
    const right = { read: receiver };
    /* left */ left.read();
    /* right */ right.read();
    /* direct */ receiver();
    function maybe(flag) { if (flag) return { value: 1 }; }
    /* maybe */ maybe(true);
    const arrow = () => this;
    /* lexical */ arrow();
  `)
  for (const [marker, callee, expected] of [
    ['/* left */', 'left.read', '{ read: receiver }'],
    ['/* right */', 'right.read', '{ read: receiver }']
  ]) {
    const values = checked.session.valuesOf(checked.targetCall(marker!, callee!))
    assert.ok(values, marker)
    assert.equal(values.length, 1, marker)
    assert.ok(values[0]!.getText(checked.file) === expected, marker)
  }
  const left = checked.session.valuesOf(checked.targetCall('/* left */', 'left.read'))![0]
  const right = checked.session.valuesOf(checked.targetCall('/* right */', 'right.read'))![0]
  assert.ok(left !== right)
  for (const [marker, callee] of [
    ['/* direct */', 'receiver'],
    ['/* lexical */', 'arrow']
  ]) {
    const values = checked.session.valuesOf(checked.targetCall(marker!, callee!))
    assert.ok(values, marker)
    assert.equal(values.length, 1, marker)
    assert.ok(ts.isVoidExpression(values[0]!), marker)
  }
  const maybe = checked.session.valuesOf(checked.targetCall('/* maybe */', 'maybe'))
  assert.ok(maybe)
  assert.equal(maybe.length, 2)
  assert.ok(maybe.some(ts.isVoidExpression))
  assert.ok(maybe.some(ts.isObjectLiteralExpression))
})

test('a receiver destructured out of an object resolves through the same slot the property spelling reads', () => {
  // `template({ app }: { app: App })` with `<HomeView app={this}/>` is every
  // view in `taurus-display`, and it refused while `p.app.run()` — the same
  // read, spelled as a property — resolved. Destructuring is a slot read; the
  // graph now says so once, so the two spellings cannot disagree.
  const runner = 'interface Runner { run(): number }'
  const method = '{ run() { return 1 } }'
  for (const [why, source, marker, callee] of [
    [
      'a parameter taken apart',
      `${runner}
       function view({ runner }: { runner: Runner }) { return /* target */ runner.run() }
       view({ runner: ${method} });`,
      '/* target */',
      'runner.run'
    ],
    [
      'a renamed element of a nested pattern',
      `${runner}
       function view({ inner: { runner: held } }: { inner: { runner: Runner } }) { return /* target */ held.run() }
       view({ inner: { runner: ${method} } });`,
      '/* target */',
      'held.run'
    ],
    [
      'a positional element, past an omitted one',
      `${runner}
       function view([, runner]: [number, Runner]) { return /* target */ runner.run() }
       view([1, ${method}]);`,
      '/* target */',
      'runner.run'
    ],
    [
      'a local declaration taken apart',
      // Annotated so the callee's symbol is the INTERFACE member: without it
      // the checker types `runner` by the literal and `ownsInvocation` --
      // which partitions on an interface member -- correctly disclaims the
      // call as an ordinary object method, a domain still owned by the legacy
      // resolver.
      `${runner}
       const props: { runner: Runner } = { runner: ${method} };
       const { runner } = props;
       /* target */ runner.run();`,
      '/* target */',
      'runner.run'
    ]
  ] as const) {
    const checked = inspect(source)
    const call = checked.targetCall(marker, callee)
    assert.equal(checked.session.ownsInvocation(call), true, why)
    assert.deepEqual(checked.bodyTexts(call), ['run() { return 1 }'], why)
    // Query order must not change an answer: the same session, asked the
    // receiver's value first and the call's targets second, agrees.
    const reversed = inspect(source)
    const reversedCall = reversed.targetCall(marker, callee)
    assert.ok(reversed.session.valuesOf((reversedCall.expression as ts.PropertyAccessExpression).expression), why)
    assert.deepEqual(reversed.bodyTexts(reversedCall), ['run() { return 1 }'], why)
  }
})

test('a defaulted binding element resolves when every reachable literal states the key outright', () => {
  // A JavaScript class constructor that destructures its whole options bag with a
  // default on nearly every field (`const { canvas = createCanvasElement(),
  // context = null, ... } = parameters`), and every call site states every
  // field as a plain literal property. JS only consults a destructuring
  // default when the read is exactly `undefined`, and a literal's own stated
  // property is never that by omission -- so when `ownEntries` proves the key
  // is present on every reachable root, the default is dead code and this
  // resolves exactly like the non-defaulted case in the test above.
  const runner = 'interface Runner { run(): number }'
  const method = '{ run() { return 1 } }'
  const source = `${runner}
     function view({ runner = ${method} }: { runner?: Runner }) { return /* target */ runner.run() }
     view({ runner: ${method} });`
  const checked = inspect(source)
  const call = checked.targetCall('/* target */', 'runner.run')
  assert.equal(checked.session.ownsInvocation(call), true)
  assert.deepEqual(checked.bodyTexts(call), ['run() { return 1 }'])
})

test('destructuring does not weaken a slot proof: rest, defaults, replacement and escape still refuse', () => {
  const runner = 'interface Runner { run(): number }'
  const method = '{ run() { return 1 } }'
  for (const [why, source, marker, callee] of [
    [
      // A rest element builds a FRESH object out of the keys nothing else
      // took. That object is not modelled, so neither is what it holds.
      'a rest element names an object this graph did not build',
      `${runner}
       function view({ ...rest }: { runner: Runner }) { return /* target */ rest.runner.run() }
       view({ runner: ${method} });`,
      '/* target */',
      'rest.runner.run'
    ],
    [
      // A defaulted element still depends on a presence fact when the
      // container it is destructured out of is not a closed set of object
      // literals that each state the key outright -- here the caller's
      // literal OMITS `runner` on one reachable call, so the default really
      // can fire. See the sibling test below for the literal-always-states-it
      // case, which this graph now resolves through `ownEntries`.
      'a defaulted element whose presence a reachable caller cannot guarantee',
      `${runner}
       function view({ runner = ${method} }: { runner?: Runner }) { return /* target */ runner.run() }
       view({ runner: ${method} });
       view({});`,
      '/* target */',
      'runner.run'
    ],
    [
      // `ownEntries` refuses outright the moment a literal contains ANY
      // spread, even when the key itself is also stated as a plain property:
      // a spread's own contents are not enumerable here, so nothing can
      // prove the later property is the one that wins. The default stays
      // live conservatively.
      'a defaulted element behind a literal spread `ownEntries` cannot see through',
      `${runner}
       declare const rest: { runner?: Runner }
       function view({ runner = ${method} }: { runner?: Runner }) { return /* target */ runner.run() }
       view({ ...rest, runner: ${method} });`,
      '/* target */',
      'runner.run'
    ],
    [
      'the slot is replaced from unknown code before it is taken apart',
      `${runner}
       declare function other(): Runner;
       const props = { runner: ${method} };
       props.runner = other();
       const { runner } = props;
       /* target */ runner.run();`,
      '/* target */',
      'runner.run'
    ],
    [
      // The pattern read is not an escape, but every OTHER use of the
      // container is still walked, and unknown code holding it can replace
      // the slot before the destructuring runs.
      'the container escapes into unknown code',
      `${runner}
       declare function sink(value: unknown): void;
       const props = { runner: ${method} };
       sink(props);
       const { runner } = props;
       /* target */ runner.run();`,
      '/* target */',
      'runner.run'
    ],
    [
      'the container comes from a call this graph cannot see into',
      `${runner}
       declare function make(): { runner: Runner };
       const { runner } = make();
       /* target */ runner.run();`,
      '/* target */',
      'runner.run'
    ]
  ] as const) {
    const checked = inspect(source)
    assert.ok(checked.bodyTexts(checked.targetCall(marker, callee)) === null, why)
  }
})

test('a class instance dispatches through a callable member slot, and a replaced slot still refuses', () => {
  // Asked for the targets of `a.go()` on `const a = new App()` -- the simplest
  // class call in the language -- this graph used to answer
  // `unmodelled-descriptor @ new App()`. Its only notion of an instance slot
  // was `sourceClassDataMemberPlanOf`, which admits DATA members; a method is
  // not one, so the slot the call dispatches through did not exist. That is
  // what made every `this.method(...)` and `app.go(...)` on a class the legacy
  // resolver's business by default rather than by partition.
  const app = 'class App { go(name: string) { return name } }'
  for (const [why, source, callee, expected] of [
    [
      'a construction held in a local',
      `${app} const a = new App(); /* target */ a.go("home");`,
      'a.go',
      'go(name: string) { return name }'
    ],
    [
      'a receiver destructured out of a prop object, taurus-shaped',
      `${app}
       class View { template({ app }: { app: App }) { return /* target */ app.go("home") } }
       const held = new App();
       new View().template({ app: held });`,
      'app.go',
      'go(name: string) { return name }'
    ],
    [
      'a lexical receiver inside a sibling method',
      `class App { go(n: string) { return n } run() { return /* target */ this.go("home") } }
       new App().run();`,
      'this.go',
      'go(n: string) { return n }'
    ],
    [
      'the override, not the base declaration',
      `class B { go(n: string) { return n } }
       class D extends B { go(n: string) { return n + "!" } }
       function view({ app }: { app: B }) { return /* target */ app.go("home") }
       view({ app: new D() });`,
      'app.go',
      'go(n: string) { return n + "!" }'
    ]
  ] as const) {
    const checked = inspect(source)
    assert.deepEqual(checked.bodyTexts(checked.targetCall('/* target */', callee)), [expected], why)
  }

  // A union of two source classes keeps BOTH bodies: a receiver built from a
  // choice of classes losing its targets is a missing union in the authority,
  // never a reason to answer one arm.
  const union = inspect(`
    class B { go(n: string) { return n } }
    class C { go(n: string) { return n + "!" } }
    declare const flag: boolean;
    const a: { go: (n: string) => string } = flag ? new B() : new C();
    /* target */ a.go("home");
  `)
  assert.deepEqual(union.bodyTexts(union.targetCall('/* target */', 'a.go')), [
    'go(n: string) { return n + "!" }',
    'go(n: string) { return n }'
  ])

  for (const [why, source, callee] of [
    [
      'the prototype slot is replaced from unknown code',
      `${app} declare function other(n: string): string;
       App.prototype.go = other;
       const a = new App();
       /* target */ a.go("home");`,
      'a.go'
    ],
    [
      'the instance slot is replaced from unknown code',
      `${app} declare function other(n: string): string;
       const a = new App();
       (a as unknown as { go: (n: string) => string }).go = other;
       /* target */ a.go("home");`,
      'a.go'
    ],
    [
      'one arm of the family answers the key with an accessor, which runs code',
      `class B { go(n: string) { return n } }
       class C { get go(): (n: string) => string { return (n) => n } }
       declare const flag: boolean;
       const a: { go: (n: string) => string } = flag ? new B() : new C();
       /* target */ a.go("home");`,
      'a.go'
    ],
    [
      'the receiver itself is handed to unknown code, which can replace the slot',
      `${app} declare function sink(value: unknown): void;
       const a = new App();
       sink(a);
       /* target */ a.go("home");`,
      'a.go'
    ],
    [
      'the receiver is published on the global object',
      `${app} const a = new App();
       (globalThis as unknown as { held: unknown }).held = a;
       /* target */ a.go("home");`,
      'a.go'
    ]
  ] as const) {
    const checked = inspect(source)
    assert.ok(checked.bodyTexts(checked.targetCall('/* target */', callee)) === null, why)
  }
})

test('a getter read on a construction resolves through the setter that stores its backing field', () => {
  // `source.depthTexture` in a class's `copy( source )` is a getter over
  // `this._depthTexture`, and the value reaching it comes from whatever a
  // plain store to the accessor key ran through the SETTER -- `getterReadOf`
  // and `settersOf` joint, not two separate proofs.
  const checked = inspect(`
    class Box {
      _size = 0;
      get size() { return this._size }
      set size(v) { this._size = v }
    }
    const b = new Box();
    b.size = 7;
    /* target */ const s = b.size;
  `)
  const propertyRead = targetExpression(checked.file, '/* target */', 'b.size')
  const values = withLedger(checked, () => checked.session.valuesOf(propertyRead))
  assert.ok(
    values,
    checked.session
      .explainValue(propertyRead)
      .map((cause) => (cause.kind === 'opaque' ? cause.cause.reason : cause.kind))
      .join(', ')
  )
  const texts = values.map((held) => held.getText(checked.file))
  assert.ok(texts.includes('7'), texts.join(', '))
})

test('a setter parameter collects every store that runs it, including through a base-typed cell', () => {
  // `parameterValuesOf` on a setter's own parameter: every value a plain
  // store to its accessor key can hand it, across every construction of the
  // family -- not the unrelated key of a plain object literal that merely
  // shares the setter's name.
  const direct = inspect(`
    class Target {
      _depth = null;
      set depth(current) { this._depth = current }
      get depth() { return this._depth }
    }
    const t = new Target();
    t.depth = { id: 1 };
    const other = { depth: 2 };
  `)
  const currentParameter = setterParameterOf(direct.file, 'depth')
  const currentValues = withLedger(direct, () => direct.session.parameterValuesOf(currentParameter))
  assert.ok(currentValues)
  const currentTexts = currentValues.map((held) => held.getText(direct.file))
  assert.ok(currentTexts.includes('{ id: 1 }'), currentTexts.join(', '))
  assert.ok(!currentTexts.includes('2'), currentTexts.join(', '))

  // The family is by heritage: a store through a DERIVED construction still
  // runs the BASE class's setter, and that store's value must still reach
  // the base setter's own parameter.
  const inherited = inspect(`
    class Base { set depth(v) { this._d = v } }
    class Derived extends Base {}
    const d = new Derived();
    d.depth = 3;
  `)
  const vParameter = setterParameterOf(inherited.file, 'depth')
  const vValues = withLedger(inherited, () => inherited.session.parameterValuesOf(vParameter))
  assert.ok(vValues)
  const vTexts = vValues.map((held) => held.getText(inherited.file))
  assert.ok(vTexts.includes('3'), vTexts.join(', '))
})

test('native copy closure follows nested erased property positions and noncoercing Has receivers', () => {
  const checked = inspect(`
    const target = {};
    const source = { depth: 1 };
    const held = /* assign */ Object.assign(target, source);
    'depth' in held;
    ((held as { depth?: unknown }) as any).depth;
  `)
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
  assert.ok(captured.value)
  assert.equal(captured.value.targets[0]!.getText(checked.file), '{}')
  assert.equal(captured.value.sources[0]!.roots[0]!.slots[0]!.key, 'depth')
  const coerced = inspect(`const target = {}; const source = { depth: 1 }; source in {}; /* assign */ Object.assign(target, source);`)
  assert.ok(
    coerced.ledger.capture(() => coerced.session.ownAssignmentOf(coerced.targetCall('/* assign */', 'Object.assign'))).value === null,
    'the left operand of in still exposes its coercion protocol'
  )
  const tested = inspect(
    `class Kind {} const target = {}; const source = { depth: 1 }; source instanceof Kind; /* assign */ Object.assign(target, source);`
  )
  assert.ok(
    tested.ledger.capture(() => tested.session.ownAssignmentOf(tested.targetCall('/* assign */', 'Object.assign'))).value,
    'the left operand of an ordinary instanceof only has its prototype chain walked'
  )
  const hooked = inspect(
    `declare function publish(value: unknown): void; class Kind { static [Symbol.hasInstance](value: unknown) { publish(value); return false } } const target = {}; const source = { depth: 1 }; source instanceof Kind; /* assign */ Object.assign(target, source);`
  )
  assert.ok(
    hooked.ledger.capture(() => hooked.session.ownAssignmentOf(hooked.targetCall('/* assign */', 'Object.assign'))).value === null,
    'a custom @@hasInstance receives the left operand'
  )
  const delegated = inspect(`
    class Base { copy(source: Base) { return this } }
    class Derived extends Base { copy(source: Base) { if (source instanceof Derived) super.copy(source); return this } }
    const held = new Derived();
    held.copy(new Derived());
    /* assign */ Object.assign({ held }, { depth: 1 });
  `)
  assert.ok(
    delegated.ledger.capture(() => delegated.session.ownAssignmentOf(delegated.targetCall('/* assign */', 'Object.assign'))).value,
    'a super member call runs with its calling frame receiver, not one owned by the class'
  )
})

test('a described source may hold literals whose own complete key domain its type declares', () => {
  // Production hands the session the keys each source's representation lays
  // out (`representedDataKeysOf`); here that representation is the operand's
  // declared type.
  const describedAssignOf = (checked: ReturnType<typeof inspect>) =>
    checked.ledger.capture(() =>
      checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign'), undefined, (expression) =>
        checked.checker
          .getNonNullableType(checked.checker.getTypeAtLocation(expression))
          .getProperties()
          .map((property) => property.name)
      )
    )
  const shape = (call: string) => `
    function make(options: { b?: number } = {}) {
      const merged = /* assign */ Object.assign({ a: 1 }, options);
      return merged + '';
    }
    ${call};
  `
  const described = inspect(shape('make({ b: 2 })'))
  const captured = describedAssignOf(described)
  assert.ok(captured.value, 'a coerced target refuses the closed family, and the source literals are their own proof')
  assert.deepEqual(captured.value.sources[0]!.described?.keys, ['b'])
  const rebound = inspect(`
    function make(options: { b?: number } = {}) {
      options = /* assign */ Object.assign({ a: 1 }, options);
      return options + '';
    }
    make({ b: 2 });
  `)
  assert.deepEqual(
    describedAssignOf(rebound).value?.sources[0]!.described?.keys,
    ['b'],
    'a use after the parameter is rebound reads the copy, not the incoming literals'
  )
  for (const call of [
    'const extra = { b: 2, c: 3 }; make(extra)',
    'const held = { b: 2 }; held + ""; make(held)',
    'const held = { b: 2 }; Object.defineProperty(held, "b", { get() { return 3 } }); make(held)'
  ]) {
    const refused = inspect(shape(call))
    assert.ok(describedAssignOf(refused).value === null, call)
  }
})

test('a plain source copied by object spread retains its closed writer inventory', () => {
  const checked = inspect(`
    function make() { const source = { depth: 1 }; source.depth = 2; return source; }
    const target = {};
    const copy = { ...make() };
    /* assign */ Object.assign(target, make());
  `)
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
  assert.ok(captured.value)
  assert.deepEqual(captured.value.sources[0]!.roots[0]!.slots[0]!.values.map((value) => value.getText(checked.file)).sort(), ['1', '2'])
  const exposed = inspect(`
    declare function publish(value: unknown): void;
    const source: { self?: unknown } = {};
    source.self = source;
    const copy = { ...source };
    publish(copy.self);
    /* assign */ Object.assign({}, source);
  `)
  assert.ok(
    exposed.ledger.capture(() => exposed.session.ownAssignmentOf(exposed.targetCall('/* assign */', 'Object.assign'))).value === null,
    'an identity copied from a slot must continue to the copied property consumer'
  )
})

// The closed literal family carries the target's slot domains and JSON hook
// obligations; where it refuses, a description of the source may still copy,
// and the target's own native object data answers its observers
// (`object-assign-described-copy-into-json-observed-target.runtime.ts`).
const closedFamilyOf = (value: { readonly sources: readonly { readonly described?: unknown }[] } | null): boolean =>
  value !== null && value.sources.every((source) => source.described === undefined)

test('intact JSON observation keeps primitive native slots closed with exact member and hook obligations', () => {
  const checked = inspect(`
    const target = { label: 'old' };
    const source = { depth: 1 };
    /* assign */ Object.assign(target, source);
    JSON.stringify(target);
  `)
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
  assert.ok(captured.value)
  assert.ok(captured.requirements.some((one) => one.intrinsic === 'JSON' && one.member === 'stringify'))
  assert.ok(captured.requirements.some((one) => one.intrinsic === 'Object' && one.prototypeAbsentNames?.includes('toJSON')))
  for (const source of [
    `declare function publish(value: unknown): void; const JSON = { stringify(value: unknown) { publish(value); } }; const target = {}; /* assign */ Object.assign(target, { depth: 1 }); JSON.stringify(target);`,
    `const target = { toJSON() { return 1; } }; /* assign */ Object.assign(target, { depth: 1 }); JSON.stringify(target);`,
    `const target = { get label() { return 'seen'; } }; /* assign */ Object.assign(target, { depth: 1 }); JSON.stringify(target);`,
    `const target = {}; /* assign */ Object.assign(target, { child: {} }); JSON.stringify(target);`,
    `declare function publish(value: unknown): void; const target = {}; /* assign */ Object.assign(target, { depth: 1 }); JSON.stringify(target, (_key, value) => { publish(value); return value; });`,
    `const target = {}; const hidden = {}; const source = { depth: hidden as unknown as number }; /* assign */ Object.assign(target, source); JSON.stringify(target);`
  ]) {
    const refused = inspect(source)
    assert.ok(
      !closedFamilyOf(
        refused.ledger.capture(() => refused.session.ownAssignmentOf(refused.targetCall('/* assign */', 'Object.assign'))).value
      ),
      source
    )
  }
})

test('JSON observation of BigInt storage requires its separate prototype hook authority', () => {
  for (const observed of [false, true]) {
    const checked = inspect(`
      const target = {};
      /* assign */ Object.assign(target, { depth: 1n });
      ${observed ? 'JSON.stringify(target);' : ''}
    `)
    assert.equal(checked.program.getSemanticDiagnostics(checked.file).length, 0)
    const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
    assert.ok(closedFamilyOf(captured.value) === !observed, 'BigInt storage itself is supported, but its JSON hook is not authenticated')
  }
})

test("Object.assign copies each source's own slot values into the target it returns", () => {
  // `bulkAssignOf`: the intact `Object.assign(target, ...sources)` evaluates
  // to its target, and each source's own value under a key lands in the
  // target's slot beside whatever the target already spelled there --
  // A constructor that merges caller options over defaults builds its
  // `options` exactly this way. A second
  // call site passing `{}` is deliberately not used here: that source simply
  // lacks the key and contributes nothing to it, but a *read* of the same
  // key directly on that bare literal is an unmodelled descriptor in this
  // graph today and would refuse the whole query -- a coarseness of the
  // per-declaration join, not something this capability is asked to fix.
  const checked = inspect(`
    const defaults = { width: 1, depthTexture: null };
    function make(options) {
      options = Object.assign({ width: 1, depthTexture: null }, options);
      return /* target */ options.depthTexture;
    }
    make({ depthTexture: 5 });
  `)
  const depthTextureRead = targetExpression(checked.file, '/* target */', 'options.depthTexture')
  const values = withLedger(checked, () => checked.session.valuesOf(depthTextureRead))
  assert.ok(
    values,
    checked.session
      .explainValue(depthTextureRead)
      .map((cause) => (cause.kind === 'opaque' ? cause.cause.reason : cause.kind))
      .join(', ')
  )
  const texts = values.map((held) => held.getText(checked.file))
  assert.ok(texts.includes('null'), texts.join(', '))
  assert.ok(texts.includes('5'), texts.join(', '))
})

test('bulk native storage domains retain newly added keys and their initial absence', () => {
  const checked = inspect(`
    const target = { label: 'old' };
    const source = { depth: 1 };
    /* assign */ Object.assign(target, source);
    const observed = /* target */ target.depth;
  `)
  const call = checked.targetCall('/* assign */', 'Object.assign')
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(call))
  assert.ok(captured.value)
  assert.equal(captured.value.targets.length, 1)
  assert.deepEqual(
    captured.value.sources.map((source) => source.ordinal),
    [1]
  )
  assert.deepEqual(
    captured.value.sources[0]!.roots[0]!.slots.map((slot) => slot.key),
    ['depth']
  )
  assert.equal(
    captured.value.sources[0]!.roots[0]!.slots[0]!.values.some((value) => ts.isNumericLiteral(value) && value.text === '1'),
    true
  )
  assert.equal(captured.value.sources[0]!.roots[0]!.slots[0]!.copyPresent, true)
  const stored = captured.value.targetSlots[0]!.slots.find((slot) => slot.key === 'depth')
  assert.ok(stored)
  assert.equal(
    stored.values.some((value) => ts.isVoidExpression(value)),
    false,
    'an initial missing read does not become an actual stored undefined value'
  )
  assert.equal(
    captured.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.prototypeAbsentNames?.includes('depth')),
    true
  )
  const read = targetExpression(checked.file, '/* target */', 'target.depth')
  const values = checked.ledger.capture(() => checked.session.valuesOf(read)).value
  assert.ok(values)
  assert.equal(
    values.some((value) => ts.isVoidExpression(value)),
    true
  )
  assert.equal(
    values.some((value) => ts.isNumericLiteral(value) && value.text === '1'),
    true
  )
})

test('deleted own data keys retain their writer carriers without claiming presence at a copy', () => {
  const checked = inspect(`
    const target = {};
    const source = { b: 1, a: 2 };
    delete source.b;
    source.m = 3;
    source.b = 4;
    /* assign */ Object.assign(target, source);
    JSON.stringify(target);
  `)
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
  assert.ok(captured.value)
  const slots = captured.value.sources[0]!.roots[0]!.slots
  const b = slots.find((slot) => slot.key === 'b')!
  assert.deepEqual(b.values.map((value) => value.getText(checked.file)).sort(), ['1', '4'])
  assert.equal(b.copyPresent, false, 'initial spelling is not a proof that a deleted descriptor is present at this copy')
  assert.equal(slots.find((slot) => slot.key === 'a')!.copyPresent, true)
  assert.equal(b.values.some(ts.isVoidExpression), false, 'descriptor absence does not become a stored undefined payload')
})

test('a deleted slot read needs actual prototype absence independently from its stored data inventory', () => {
  const checked = inspect(`const source = { depth: 1 }; delete source.depth; /* target */ source.depth;`)
  const read = targetExpression(checked.file, '/* target */', 'source.depth')
  const captured = checked.ledger.capture(() => checked.session.valuesOf(read))
  assert.ok(captured.value)
  assert.equal(captured.value.some(ts.isVoidExpression), true)
  assert.equal(
    captured.requirements.some((one) => one.prototypeAbsentNames?.includes('depth')),
    true
  )
  const inherited = inspect(`const source = { toString: 1 }; delete source.toString; /* target */ source.toString;`)
  assert.ok(
    inherited.ledger.capture(() => inherited.session.valuesOf(targetExpression(inherited.file, '/* target */', 'source.toString')))
      .value === null,
    'an existing prototype member cannot become undefined after deleting its own shadow'
  )
})

test('a later bulk source carries the keys and actual values installed by an earlier bulk write', () => {
  const checked = inspect(`
    const target = { label: 'old' };
    const source = {};
    Object.assign(source, { depth: 3 });
    /* assign */ Object.assign(target, source);
  `)
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
  assert.ok(captured.value)
  const slots = captured.value.sources[0]!.roots[0]!.slots
  assert.deepEqual(
    slots.map((slot) => slot.key),
    ['depth']
  )
  assert.equal(
    slots[0]!.values.some((value) => ts.isNumericLiteral(value) && value.text === '3'),
    true
  )
  assert.equal(slots[0]!.copyPresent, false, 'a finite added-key domain alone does not prove the installing copy executed')
})

test('bulk target storage includes later writes through a closed native parameter alias', () => {
  const checked = inspect(`
    const target = { label: 'old' };
    function update(value: { depth: number | string }) { value.depth = 'later'; }
    /* assign */ Object.assign(target, { depth: 1 });
    update(target as typeof target & { depth: number });
  `)
  const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
  assert.ok(captured.value)
  const slot = captured.value.targetSlots[0]!.slots.find((slot) => slot.key === 'depth')
  assert.ok(slot)
  assert.equal(
    slot.values.some((value) => ts.isNumericLiteral(value) && value.text === '1'),
    true
  )
  assert.equal(
    slot.values.some((value) => ts.isStringLiteral(value) && value.text === 'later'),
    true
  )
})

test('bulk source storage refuses open consumers, computed writers and accessor sources', () => {
  for (const source of [
    `declare function publish(value: unknown): void; const target = {}; const source = { depth: 1 }; publish(source); /* assign */ Object.assign(target, source);`,
    `declare const key: string; const target = {}; const source = { depth: 1 }; source[key] = 2; /* assign */ Object.assign(target, source);`,
    `const target = {}; const source = { get depth() { return 1 } }; /* assign */ Object.assign(target, source);`
  ]) {
    const checked = inspect(source)
    const captured = checked.ledger.capture(() => checked.session.ownAssignmentOf(checked.targetCall('/* assign */', 'Object.assign')))
    assert.equal(captured.value === null, true)
  }
})

test('finite computed native slot writes share the complete original allocation closure', () => {
  const checked = inspect(`
    const original = {};
    const table: Record<string, { error: boolean; debug: boolean }> = {};
    table.command = original as { error: boolean; debug: boolean };
    for (const level of ['error', 'debug'] as const) table.command[level] = level === 'error';
    const observed = /* target */ table.command;
  `)
  const owner = targetExpression(checked.file, '/* target */', 'table.command')
  for (const key of ['error', 'debug']) {
    const captured = checked.ledger.capture(() => checked.session.ownSlotOf(owner, key))
    assert.ok(captured.value)
    assert.equal(captured.value.roots.length, 1)
    assert.equal(captured.value.roots[0]!.writes.length, 1)
    assert.ok(captured.value.roots[0]!.values.length > 0)
  }
})

test('native own slot owners distinguish abrupt nullish lookup from stored undefined', () => {
  const mixed = inspect(`
    declare const condition: boolean;
    const original = {}; original.extra = undefined;
    const owner = condition ? null : original;
    /* target */ owner;
  `)
  const owner = targetExpression(mixed.file, '/* target */', 'owner')
  const proof = mixed.ledger.capture(() => mixed.session.ownSlotOf(owner, 'extra')).value
  assert.ok(proof)
  assert.equal(proof.roots.length, 1)
  assert.equal(proof.roots[0]!.root.getText(mixed.file), '{}')
  assert.equal(proof.roots[0]!.writes.length, 1)
  assert.equal(proof.roots[0]!.values.length, 1, 'the actual stored undefined remains in the payload domain')
  assert.ok(ts.isVoidExpression(proof.roots[0]!.values[0]!))

  for (const source of [
    'const owner = null; /* target */ owner;',
    'const owner = undefined; /* target */ owner;',
    'declare const condition: boolean; const original = {}; original.extra = 7; const owner = condition ? 1 : original; /* target */ owner;',
    'declare function publish(value: unknown): void; const original = {}; original.extra = 7; publish(original); const owner = original; /* target */ owner;'
  ]) {
    const checked = inspect(source)
    const target = targetExpression(checked.file, '/* target */', 'owner')
    assert.ok(checked.ledger.capture(() => checked.session.ownSlotOf(target, 'extra')).value === null, source)
  }
})

test('canonical intrinsic own data replacements publish the installed source frame', () => {
  const checked = inspect(`
    Object.freeze = (value: any) => value;
    const changed = /* target */ Object.freeze(1);
    const intact = Object.seal(1);
  `)
  const call = checked.targetCall('/* target */', 'Object.freeze')
  const captured = checked.ledger.capture(() => checked.session.invocationTargetsOf(call))
  assert.deepEqual(
    captured.value?.map((body) => body.getText(checked.file)),
    ['(value: any) => value']
  )
  assert.equal(checked.session.ownsInvocation(call), true)
  assert.ok(captured.requirements.some((one) => one.intrinsic === 'Object' && one.member === 'prototype'))
  assert.ok(captured.requirements.some((one) => one.intrinsic === 'Function' && one.prototypeKeys?.names?.includes('freeze')))
  assert.equal(
    captured.requirements.some((one) => one.intrinsic === 'Object' && one.member === 'freeze'),
    false
  )
})

test('intrinsic replacement effects require the same actual source installation and complete invocation frame', () => {
  const checked = inspect(`
    Object.freeze = (value: any) => value;
    const changed = /* target */ Object.freeze(1);
    const intact = Object.seal(1);
  `)
  const call = checked.targetCall('/* target */', 'Object.freeze')
  const authority = closedCallableAuthorityOf(
    checked.checker,
    checked.flow,
    (value) => checked.checker.getTypeAtLocation(value),
    () => undefined
  )
  const fact = checked.ledger.capture(() => authority.invocationFactOf(call)).value
  assert.ok(fact)
  const proof = checked.ledger.capture(() => sourceIntrinsicMemberInvocationOf(checked.checker, checked.flow, fact))
  assert.ok(proof.value)
  assert.ok(proof.value.site.left === proof.value.installation)
  assert.ok(proof.value.body === fact.frames[0]!.body)
  assert.ok(proof.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.member === 'prototype'))
  assert.ok(proof.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.member === 'seal'))
  assert.equal(
    proof.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.member === 'freeze'),
    false
  )
  const seal = checked.file.statements.find(
    (statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.name.getText() === 'intact'
  )
  assert.ok(seal && ts.isVariableStatement(seal))
  const other = seal.declarationList.declarations[0]!.initializer
  assert.ok(other && ts.isCallExpression(other))
  assert.ok(ts.isPropertyAccessExpression(other.expression))
  for (const forged of [
    { ...fact, operands: { ...fact.operands, receiver: null } },
    { ...fact, operands: { ...fact.operands, callee: other.expression } },
    { ...fact, operands: { ...fact.operands, args: [] } },
    { ...fact, frames: [...fact.frames, ...fact.frames] },
    { ...fact, frames: [{ ...fact.frames[0]!, layout: { ...fact.frames[0]!.layout, call: other } }] }
  ])
    assert.ok(checked.ledger.capture(() => sourceIntrinsicMemberInvocationOf(checked.checker, checked.flow, forged)).value === null)
})

test('open intrinsic own installations cannot borrow the original library callee', () => {
  for (const preparation of [
    'declare const condition: boolean; if (condition) Object.freeze = (value: any) => value;',
    'function install() { Object.freeze = (value: any) => value; } install();',
    'Object.freeze = (value: any) => value; Object.freeze = (value: any) => value;',
    'declare const replacement: any; Object.freeze = replacement;',
    'Object.freeze = function(value: any) { return this; };',
    'Object.freeze = (value: any) => value; declare function publish(value: unknown): void; publish(Object);',
    'Object.freeze = (value: any) => value; const extracted = Object.freeze;',
    'Object.freeze = (value: any) => value; const alias = Object;',
    'Object.freeze = (value: any) => value; declare const key: string; (Object as any)[key] = 1;',
    "Object.freeze = (value: any) => value; (globalThis as any)['Object']['freeze'] = (value: any) => 0;",
    "Object.freeze = (value: any) => value; Reflect.set((globalThis as any)['Object'], 'freeze', (value: any) => 0);",
    "Object.defineProperty(Object, 'freeze', { value: (value: any) => value });"
  ]) {
    const checked = inspect(`${preparation} const changed = /* target */ Object.freeze(1);`)
    const call = checked.targetCall('/* target */', 'Object.freeze')
    assert.ok(checked.ledger.capture(() => checked.session.invocationTargetsOf(call)).value === null, preparation)
  }
})
