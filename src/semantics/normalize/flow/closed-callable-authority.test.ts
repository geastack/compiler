import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements
} from '../deferred-intrinsic-protocols.js'
import { createIdentityTable } from '../identities.js'
import { censusGlobalHostMutations } from '../global-host-mutations.js'
import { censusUnresolvableNames } from '../unresolvable-names.js'
import { attachClosedScriptScope } from './targets.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { censusParameterBindings, indexParameterBindingProgram } from '../parameter-bindings.js'

/** The frame `closedCallableAuthorityOf` gives the parameter spelled `second`, as source text. */
/** The graph's own answer for the first `new this.constructor()` in `source`: what the fresh object is, or null. */
const constructionValue = (source: string, js = false): readonly string[] | null => {
  const entry = resolve(`test/fixtures/closed-callable-authority.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let construction: ts.NewExpression | undefined
  const visit = (node: ts.Node): void => {
    if (!construction && ts.isNewExpression(node) && node.expression.getText(file) === 'this.constructor') construction = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(construction, 'new this.constructor()')
  const values = ledger.capture(() => sourceValueSessionOf(checker, flow).valuesOf(construction!)).value
  return values === null ? null : values.map((value) => (ts.isVoidExpression(value) ? 'undefined' : value.getText(file))).sort()
}

const frame = (
  source: string,
  js = false,
  module = true,
  closedScriptScope = false,
  sealGlobalBinding = false
): readonly string[] | null => {
  const entry = resolve(`test/fixtures/closed-callable-authority.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: js, checkJs: js }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `${module ? 'export {};\n' : ''}${source}`, version, true)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  if (closedScriptScope) attachClosedScriptScope(flow, { files: new Set([file]) })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  let second: ts.ParameterDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'second') second = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(second)
  const captured = ledger.capture(() => authority.parameterValuesOf(second!))
  const values = captured.value
  const repeated = ledger.capture(() => authority.parameterValuesOf(second!))
  assert.deepEqual(repeated.value, values)
  assert.deepEqual(repeated.requirements, captured.requirements, 'cached frame queries retain every prototype obligation')
  if (values !== null && source.includes('take.call'))
    assert.ok(captured.requirements.some((requirement) => requirement.intrinsic === 'Function'))
  if (sealGlobalBinding && values !== null) {
    const globals = captured.requirements.filter((requirement) => requirement.sourceGlobalBinding !== undefined)
    assert.equal(globals.length, 1)
    const global = globals[0]!
    assert.ok(ts.isVariableDeclaration(global.sourceGlobalBinding!))
    assert.equal(global.sourceGlobalBinding!.name!.getText(file), 'held')
    assert.equal(global.location, global.sourceGlobalBinding)
    const identities = createIdentityTable(program, checker)
    const taint = censusGlobalHostMutations(checker, identities, [file], censusUnresolvableNames(checker, [file]), new Set(), flow)
    const failed = failedIntrinsicProtocolRequirements(
      {
        checker,
        identities,
        globalHostMutationTaint: taint,
        isStandardLibraryDeclaration: (node) => program.isSourceFileDefaultLibrary(node.getSourceFile())
      },
      captured.requirements
    )
    if (failed.length > 0) return null
  }
  return values === null ? null : values.map((value) => (ts.isVoidExpression(value) ? 'undefined' : value.getText(file))).sort()
}

test('script lexical receivers remain exposed independently of binding immutability', () => {
  const owner = 'class Owner { value = 0; take(second) { this.value = second } }'
  for (const binding of ['const', 'let', 'var'])
    assert.equal(frame(`${owner} ${binding} held = new Owner(); held.take(1);`, false, false), null)
  const source = `${owner} const held = new Owner(); held.take(1); held.take(2);`
  assert.deepEqual(frame(source), ['1', '2'])
  assert.equal(frame(`${source} declare function external(value: unknown): void; external(held);`), null)
  assert.equal(frame(`${source} declare function replacement(value: number): void; Owner.prototype.take = replacement;`), null)
})

test('a stated script lexical realm closes bindings while retaining object and prototype obligations', () => {
  const owner = 'class Owner { value = 0; take(second) { this.value = second } }'
  for (const binding of ['const', 'let']) {
    const source = `${owner} ${binding} held = new Owner(); held.take(1); held.take(2);`
    assert.deepEqual(frame(source, false, false, true), ['1', '2'])
    assert.equal(frame(`${source} declare function external(value: unknown): void; external(held);`, false, false, true), null)
    assert.equal(
      frame(`${source} declare function replacement(value: number): void; Owner.prototype.take = replacement;`, false, false, true),
      null
    )
  }
  const global = `${owner} var held = new Owner(); held.take(1);`
  assert.deepEqual(frame(global, false, false, true, true), ['1'])
  assert.equal(frame(global, false, false), null)
  for (const effect of [
    'held = new Owner();',
    'declare function external(value: unknown): void; external(held);',
    'declare function replacement(value: number): void; Owner.prototype.take = replacement;',
    'declare const key: string; (globalThis as any)[key] = undefined;',
    'const realm = globalThis; (realm as any).held = undefined;'
  ])
    assert.equal(frame(`${global} ${effect}`, false, false, true, true), null, effect)
})

test('a closed script realm includes writes and callers from every script', () => {
  const entry = resolve('test/fixtures/script-scope-entry.ts')
  const sibling = resolve('test/fixtures/script-scope-sibling.ts')
  for (const opaque of [false, true]) {
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
    const host = ts.createCompilerHost(options)
    const read = host.getSourceFile.bind(host)
    const sources = new Map([
      [entry, 'class Owner { value = 0; take(second) { this.value = second } } let held = new Owner(); held.take(1);'],
      [sibling, opaque ? 'declare function outside(): any; held = outside(); held.take(2);' : 'held = new Owner(); held.take(2);']
    ])
    host.getSourceFile = (name, version, ...rest) => {
      const text = sources.get(resolve(name))
      return text === undefined ? read(name, version, ...rest) : ts.createSourceFile(name, text, version, true)
    }
    const program = ts.createProgram([entry, sibling], options, host)
    const checker = program.getTypeChecker()
    const files = [program.getSourceFile(entry)!, program.getSourceFile(sibling)!]
    const flow = indexValueFlow(checker, files, wholeProgram)
    attachClosedScriptScope(flow, { files: new Set(files) })
    const owner = files[0]!.statements.find(ts.isClassDeclaration)!
    const take = owner.members.find(ts.isMethodDeclaration)!
    const authority = closedCallableAuthorityOf(
      checker,
      flow,
      () => null,
      () => undefined
    )
    const values = authority.parameterValuesOf(take.parameters[0]!)
    assert.deepEqual(values?.map((value) => value.getText()).sort() ?? null, opaque ? null : ['1', '2'])
  }
})

test('an omitted argument is the value undefined, and a spread before the slot refuses', () => {
  const take = 'function take(first: number, second?: number) { return second }'
  assert.deepEqual(frame(`${take} take(1); take(2, 3);`), ['3', 'undefined'])
  // A stated default is what an omitted argument binds.
  assert.deepEqual(frame('function take(first: number, second = 4) { return second } take(1);'), ['4'])
  assert.equal(frame(`${take} const pair: [number, number] = [1, 2]; take(...pair);`), null)
  // A function no closed inventory covers answers no frame at all.
  assert.equal(frame(`${take} take(1); declare function external(value: unknown): void; external(take);`), null)
})

test('a same-key override contributes only calls that enter the selected base body', () => {
  assert.deepEqual(
    frame(`
      class Base { take(second: number) { return second } }
      class Derived extends Base { take(value: number) { super.take(3); return value } }
      new Base().take(1)
      new Derived().take(2)
    `),
    ['1', '3']
  )
})

test('a retained returned member cannot infer an arguments frame from only its direct caller', () => {
  const entry = resolve('test/fixtures/closed-callable-retained-member.js')
  const source = `
    function factory() {
      function method() { return arguments[0] }
      return { method }
    }
    const retained = []
    function retain(value) { retained.push(value) }
    const record = factory()
    retain(record)
    record.method(1)
    retained[0].method('text')
  `
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, allowJs: true }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(flow, { files: new Set([file]) })
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const factory = file.statements.find(ts.isFunctionDeclaration)!
  const method = factory.body!.statements.find(ts.isFunctionDeclaration)!
  const frame = ledger.capture(() => {
    const index = indexParameterBindingProgram(checker, [file], wholeProgram, flow)
    const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index, flow)
    assert.ok(census.implicitArgumentsTupleAt)
    return census.implicitArgumentsTupleAt(method)
  })
  assert.equal(frame.value, null, 'the uncounted call through retained array storage keeps the complete frame open')
})

test('the exported authority answers callers from the same closed inventory', () => {
  const entry = resolve('test/fixtures/closed-callable-authority.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const source = 'export {};\nfunction take(second: number) { return second } take(1); take(2);'
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const take = file.statements.find(ts.isFunctionDeclaration)!
  assert.equal(authority.closedCallerSitesOf?.(take)?.length, 2)
})

test('a stable local anonymous callable initializer owns its complete direct callers', () => {
  const callerCount = (source: string): number | null => {
    const entry = resolve('test/fixtures/closed-callable-authority.ts')
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
    const host = ts.createCompilerHost(options)
    const read = host.getSourceFile.bind(host)
    host.getSourceFile = (name, version, ...rest) =>
      resolve(name) === entry ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : read(name, version, ...rest)
    const program = ts.createProgram([entry], options, host)
    const checker = program.getTypeChecker()
    const file = program.getSourceFile(entry)!
    const binding = file.statements.find(ts.isVariableStatement)!.declarationList.declarations[0]!
    const initializer = binding.initializer!
    assert.ok(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    const flow = indexValueFlow(checker, [file], wholeProgram)
    const authority = closedCallableAuthorityOf(
      checker,
      flow,
      () => null,
      () => undefined
    )
    return authority.closedCallerSitesOf(initializer)?.length ?? null
  }
  for (const initializer of ['(value: number) => value', 'function(value: number) { return value; }']) {
    assert.equal(callerCount(`const take = ${initializer}; take(1); take(2);`), 2)
    assert.equal(callerCount(`let take = ${initializer}; take = (value) => value + 1; take(1);`), null)
    assert.equal(callerCount(`const take = ${initializer}; declare function retain(value: unknown): void; retain(take); take(1);`), null)
    assert.equal(callerCount(`export const take = ${initializer}; take(1);`), null)
  }
})

test('explicit receiver calls retain executable parameter positions', () => {
  assert.deepEqual(
    frame('function take(this: object, first: number, second?: number) { return second } take.call({}, 1, 9); take.apply({}, [2, 8]);'),
    ['8', '9']
  )
})

test('a replaced invocation wrapper cannot certify the original function frame', () => {
  assert.equal(
    frame('function take(first: number, second?: number) { return second } take.call = function() {}; take.call({}, 1, 9);'),
    null
  )
  assert.equal(
    frame('function take(first: number, second?: number) { return second } Function.prototype.call = function() {}; take.call({}, 1, 9);'),
    null
  )
})

test('a base constructor data assignment follows source subclass setters without evaluating getters', () => {
  const source = (body: string) => `
    class Base {
      constructor() { this.type = 'Base'; }
      take(second) { return second; }
    }
    class Derived extends Base {
      get type() { external(this); return 'Derived'; }
      set type(value) { ${body} }
    }
    function external(value) { unknown(value); }
    new Base().take(1); new Derived().take(2);
  `
  assert.deepEqual(frame(source(''), true), ['1', '2'])
  assert.equal(frame(source('external(this);'), true), null)
  assert.equal(frame(source('this.take = value;'), true), null)
})

test('constructor-slot reads share receiver closure only for original source-family construction', () => {
  const source = `
    class Base { take(second) { return new this.constructor(); } }
    const value = new Base(); value.take(1);
  `
  assert.deepEqual(frame(source, true), ['1'])
  // An own `constructor` store leaves `take`'s frame intact -- `value.take(1)`
  // still binds `second` to `1` -- and makes what `new this.constructor()`
  // builds opaque. Two facts, answered separately by the graph; the legacy
  // authority refused the frame as a proxy for the second.
  const stored = source.replace('value.take(1);', 'value.constructor = function() {}; value.take(1);')
  assert.deepEqual(frame(stored, true), ['1'])
  assert.equal(constructionValue(stored, true), null)
  assert.notEqual(constructionValue(source, true), null)
  for (const changed of [
    source.replace(
      'const value',
      "class Derived extends Base { get ['constructor']() { unknown(this); return Base; } } new Derived(); const value"
    ),
    source.replace('value.take(1);', 'Object.defineProperty(value, "constructor", { value: function() { return {}; } }); value.take(1);'),
    source.replace(
      'value.take(1);',
      'Object.defineProperty(value, "constructor", { get() { unknown(value); return Base; } }); value.take(1);'
    ),
    source.replace('value.take(1);', 'unknown(value.constructor); value.take(1);'),
    source.replace('value.take(1);', 'value[unknownKey] = value; value.take(1);')
  ])
    assert.equal(frame(changed, true), null, changed)
})

test('callback field implementations consume complete constructor and forwarding frames', () => {
  const source = `
    class Reader {
      constructor(width) { this.width = width; }
      take(second) { this.width(); return second; }
    }
    function create(width) { return new Reader(width); }
    const reader = create(() => 42); reader.take(1);
  `
  assert.deepEqual(frame(source, true), ['1'])
  assert.deepEqual(frame(source.replace('() => 42', 'function() { return 42; }'), true), ['1'])
  for (const changed of [
    source.replace('() => 42', 'function() { unknown(this); }'),
    source.replace('() => 42', 'unknownCallback'),
    source.replace('reader.take(1);', 'reader.width = unknownCallback; reader.take(1);'),
    source.replace('reader.take(1);', 'create(function() { unknown(this); }); reader.take(1);')
  ])
    assert.equal(frame(changed, true), null, changed)
})

const invocationTargets = (
  source: string,
  marker: (call: ts.CallExpression) => boolean,
  expectedMember?: string
): readonly ts.SignatureDeclaration[] | null => {
  const entry = resolve('test/fixtures/closed-callable-authority.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let answer: readonly ts.SignatureDeclaration[] | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && marker(node)) {
      const proof = ledger.capture(() => authority.invocationFactOf(node))
      const repeated = ledger.capture(() => authority.invocationFactOf(node))
      assert.deepEqual(repeated.value, proof.value)
      assert.deepEqual(
        repeated.requirements.map(({ intrinsic, member, prototypeKeys }) => ({ intrinsic, member, prototypeKeys })),
        proof.requirements.map(({ intrinsic, member, prototypeKeys }) => ({ intrinsic, member, prototypeKeys }))
      )
      assert.ok(repeated.requirements.every((requirement, index) => requirement.location === proof.requirements[index]?.location))
      if (expectedMember) assert.ok(proof.requirements.some((requirement) => requirement.member === expectedMember))
      answer = proof.value?.frames.map((frame) => frame.body) ?? null
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return answer
}

/** `closedCalleeBodiesOf`'s own answer: target identity alone, independent of
 * `invocationFactOf`'s stricter promise (a complete argument-forwarding frame
 * for every target). */
const closedCalleeBodies = (source: string, marker: (call: ts.CallExpression) => boolean): readonly ts.SignatureDeclaration[] | null => {
  const entry = resolve('test/fixtures/closed-callable-authority.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    () => null,
    () => undefined
  )
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  let answer: readonly ts.SignatureDeclaration[] | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && marker(node)) {
      const proof = ledger.capture(() => authority.closedCalleeBodiesOf?.(node) ?? null)
      const repeated = ledger.capture(() => authority.closedCalleeBodiesOf?.(node) ?? null)
      assert.deepEqual(repeated.value, proof.value)
      answer = proof.value
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return answer
}

test('the shared invocation authority names a closed source member call', () => {
  const targets = invocationTargets(
    'class Renderer { draw(value: number) { return value } } const renderer = new Renderer(); renderer.draw(1);',
    (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'draw'
  )
  assert.equal(targets?.length, 1)
  assert.ok(targets?.every((target) => ts.isMethodDeclaration(target) && target.name.getText() === 'draw'))
})

test('callback field invocations use complete constructor frames for replacement validation too', () => {
  const source = `
    class Reader {
      width: () => number;
      constructor(width: () => number) { this.width = width; }
      take() { return this.width(); }
    }
    const reader = new Reader(() => 42); reader.take();
  `
  const query = (text: string) =>
    invocationTargets(text, (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'width')
  assert.equal(query(source)?.length, 1)
  assert.equal(query(source.replace('() => 42', 'function() { return 42; }'))?.length, 1)
  for (const changed of [
    source.replace('() => 42', 'externalCallback'),
    source.replace('reader.take();', 'reader.width = externalCallback; reader.take();'),
    source.replace('() => 42', 'function(this: Reader) { opaque(this); return 42; }')
  ])
    assert.equal(query(changed), null, changed)
})

test('the shared invocation authority refuses a borrowed receiver', () => {
  const targets = invocationTargets(
    'class Renderer { draw(value: number) { return value } } const renderer = new Renderer(); const draw = renderer.draw; draw(1);',
    (call) => ts.isIdentifier(call.expression) && call.expression.text === 'draw'
  )
  assert.equal(targets, null)
})

test('invocation closure composes constructor callbacks, a factory cycle and a member-returned receiver', () => {
  const source = `
    class Context {
      width: () => number;
      constructor(width: () => number) { this.width = width; }
      leaf(second: number) { return second; }
      forward(second: number) { this.width(); return this.leaf(second); }
    }
    class Canvas {
      width = 10;
      context: Context | null = null;
      setContext(context: Context) { this.context = context; }
      getContext(): Context { if (!this.context) throw new Error(); return this.context; }
    }
    function makeCanvas() {
      const canvas = new Canvas();
      canvas.setContext(new Context(() => canvas.width));
      return canvas;
    }
    const canvas = makeCanvas();
    const gl = canvas.getContext();
    declare function opaque(value: unknown): void;
    declare function externalCallback(): () => number;
    gl.forward(7);
  `
  for (const [mutation, expectedWidthTargets] of [
    ['', 1],
    ['gl.width = () => 99;', 2],
    ['opaque(gl);', null],
    ['gl.width = externalCallback();', null]
  ] as const) {
    const changed = source.replace('gl.forward(7);', `${mutation} gl.forward(7);`)
    for (const callText of ['this.width', 'this.leaf', 'gl.forward']) {
      const targets = invocationTargets(changed, (call) => call.expression.getText() === callText)
      assert.equal(
        targets?.length ?? null,
        expectedWidthTargets === null ? null : callText === 'this.width' ? expectedWidthTargets : 1,
        `${mutation || 'original'} at ${callText}`
      )
    }
  }
})

test('the shared invocation authority refuses a replaced explicit wrapper', () => {
  const targets = invocationTargets(
    'function listener(value: number) { return value } listener.call = function() {}; listener.call({}, 1);',
    (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'call'
  )
  assert.equal(targets, null)
})

test('extracted callbacks retain exact targets with an explicit receiver', () => {
  const targets = invocationTargets(
    'function listener(this: object, value: number) {} const callbacks = [listener]; const held = callbacks[0]; held.call({}, 1);',
    (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'call'
  )
  assert.equal(targets?.length, 1)
  assert.ok(targets?.every((target) => ts.isFunctionDeclaration(target) && target.name?.text === 'listener'))
  assert.equal(
    invocationTargets(
      'declare const listener: (value: number) => void; const callbacks = [listener]; const held = callbacks[0]; held.call({}, 1);',
      (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'call'
    ),
    null
  )
})

test('receiver closure carries own-key query obligations through erased array reads', () => {
  for (const [owner, key] of [
    ['Object', 'keys'],
    ['Object', 'getOwnPropertyNames'],
    ['Object', 'getOwnPropertySymbols'],
    ['Reflect', 'ownKeys']
  ] as const) {
    const targets = invocationTargets(
      `class Owner { run = (owner: Owner) => 1 }
       const values = [new Owner()]; const copy = [...values]; const owner = copy[0]! satisfies Owner;
       ${owner}.${key}(owner); 'run' in owner; owner.run(owner);`,
      (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'run',
      key
    )
    assert.equal(targets?.length, 1, `${owner}.${key}`)
  }
})

test('receiver closure refuses look-alike key queries and coercing object keys', () => {
  for (const operation of [
    'declare const fake: { keys(value: unknown): string[] }; fake.keys(owner)',
    'declare const key: object; key in owner',
    'Object.values(owner)'
  ]) {
    assert.equal(
      invocationTargets(
        `class Owner { run = (owner: Owner) => 1 } const owner = new Owner(); ${operation}; owner.run(owner);`,
        (call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'run'
      ) === null,
      true,
      operation
    )
  }
})

test('bare callback target closure distinguishes lexical from implicit receivers', () => {
  for (const initializer of ['(value: object) => 1', 'function(value: object) { return 1 }']) {
    assert.equal(
      invocationTargets(
        `const callbacks = [${initializer}]; const held = callbacks[0]!; held({});`,
        (call) => ts.isIdentifier(call.expression) && call.expression.text === 'held'
      )?.length,
      1
    )
  }
  assert.equal(
    invocationTargets(
      'const callbacks = [function(this: object) { return this }]; const held = callbacks[0]!; held();',
      (call) => ts.isIdentifier(call.expression) && call.expression.text === 'held'
    ),
    null
  )
})

test('a generic class in the heritage chain does not open a receiver family', () => {
  // `checker.getBaseTypes` answers `extends Base` with a TypeReference the
  // moment `Base` declares a type parameter -- written or defaulted, read or
  // not -- and `isClassOrInterface()` is false on that wrapper. Every heritage
  // walk that asked it directly decided the ancestry was unknown, so a class
  // extending ANY generic base refused every ordinary member call on itself.
  // That is the whole of one app in the corpus: `App extends Component<...>`
  // lost 228 invocations, each one's opaque result then tainting a host global.
  const call = 'const owner = new Owner(); owner.draw(1);'
  const owner = 'class Owner extends BASE { draw(value: number) { return value } }'
  const named = (text: string) => (call: ts.CallExpression) =>
    ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === text
  for (const base of [
    'declare class Base<T = number> { readonly tag: T }',
    'declare class Base<T> { readonly tag: T }',
    'class Base<T = number> { tag: T | undefined }',
    // The parameter is never read: the instantiation exists regardless.
    'declare class Base<T = number> { readonly tag: number }'
  ]) {
    const spelled = base.includes('<T>') ? 'Base<number>' : 'Base'
    const source = `${base}\n${owner.replace('BASE', spelled)}\n${call}`
    assert.equal(invocationTargets(source, named('draw'))?.length, 1, source)
  }
  // A non-generic class between the two hides the generic link one level up.
  const transitive = `declare class Base<T = number> { readonly tag: T }\ndeclare class Mid extends Base {}\n${owner.replace('BASE', 'Mid')}\n${call}`
  assert.equal(invocationTargets(transitive, named('draw'))?.length, 1)
})

/** A pre-ES6 `Properties()`: a factory returning `{ get: get, ... }`,
 * always invoked as `new Properties()`. TypeScript's own JS-constructor
 * inference recognizes only a `this.x = ...` body as a constructor; a plain
 * function that instead returns an object literal makes `new F()` type `any`
 * -- `checker.getResolvedSignature` then names no declaration for
 * `properties.get( material )` at all. The call still closes: `properties`'s
 * one origin is the literal `Properties` returns, that literal's `get`
 * slot is written exactly once, and the write is a source function --
 * `closedCalleeBodiesOf` reaches this by ALLOCATION (record-method-call
 * closure), never by matching the name `get` against candidate bodies. */
const propertiesFactory = `
  function Properties() {
    let properties = new WeakMap();
    function get(object) {
      let map = properties.get(object);
      if (map === undefined) { map = {}; properties.set(object, map); }
      return map;
    }
    function remove(object) { properties.delete(object); }
    return { get: get, remove: remove };
  }`
const propertiesGetMarker = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  call.expression.name.text === 'get' &&
  call.expression.expression.getText() === 'properties'

test('closedCalleeBodiesOf closes a `new`-constructed record factory from its allocation', () => {
  const source = `${propertiesFactory}
    const properties = new Properties();
    const material = {};
    const m = properties.get(material);`
  const closed = closedCalleeBodies(source, propertiesGetMarker)
  assert.equal(closed?.length, 1)
  assert.ok(closed?.every((target) => ts.isFunctionDeclaration(target) && target.name?.text === 'get'))
  // The checker itself cannot name this call's callee: the allocation, not a
  // checker-resolved signature, is what closes it.
  assert.equal(
    invocationTargets(source, propertiesGetMarker) !== null,
    true,
    'sanity: the record frame also closes (a stricter, additional promise)'
  )
})

test('closedCalleeBodiesOf refuses when the slot is replaced or the allocation is not closed', () => {
  // A later write to the SAME slot puts a different callable in the call's
  // path -- the write, not the record shape, is what must refuse this.
  const replaced = `${propertiesFactory}
    const properties = new Properties();
    properties.get = function replacement(object) { return object; };
    const material = {};
    const m = properties.get(material);`
  assert.equal(closedCalleeBodies(replaced, propertiesGetMarker), null)

  // The factory's result merged with an opaque value: `properties`'s origins
  // are no longer closed to program literals, so no slot write is provably
  // the only one reaching this call.
  const merged = `declare function external(): any
    ${propertiesFactory}
    declare const choice: boolean
    const properties: any = choice ? new Properties() : external();
    const material = {};
    const m = properties.get(material);`
  assert.equal(closedCalleeBodies(merged, propertiesGetMarker), null)
})

/** A base class's empty `beforeDraw( ) {}`: a per-instance hook. Some
 * other module does `node.beforeDraw = function( ... ) { ... }` on one
 * subclass instance from OUTSIDE any class body, so
 * `instanceMemberWritesOf` (which only sees `this.x =` / `super.x =`) never
 * learns of it and `memberImplementationsOf` alone would answer with only
 * the base's empty body. A caller then invokes `root.beforeDraw( ... )`
 * through a slot with that one instance override -- a write
 * `slotClosedForTargets`'s "nothing writes this slot" refuses outright, even
 * though the write installs a nameable compiled function. */
const beforeDrawSource = `
  class Base { beforeDraw(value: number) { return value; } }
  class Derived extends Base {}
  const instance = new Derived();
  instance.beforeDraw = function replacement(value: number) { return value + 1; };
  instance.beforeDraw(1);`
const beforeDrawMarker = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'beforeDraw'

test('closedCalleeBodiesOf admits a member slot written elsewhere with a compiled function', () => {
  const closed = closedCalleeBodies(beforeDrawSource, beforeDrawMarker)
  assert.equal(closed?.length, 2)
  assert.ok(closed?.some((target) => ts.isMethodDeclaration(target) && target.name.getText() === 'beforeDraw'))
  assert.ok(closed?.some((target) => ts.isFunctionExpression(target) && target.name?.text === 'replacement'))
  // `invocationTargetsOf` reaches the same answer here too -- this tiny,
  // self-contained fixture also satisfies `memberSlotClosed`'s stronger
  // whole-program promise (every mention of the key, not just its writes,
  // is closed), so it does not by itself demonstrate the relaxation. The
  // gap this mechanism closes only opens at a real app's scale, where
  // a base-class hook like `beforeDraw` has far more mentions than
  // `memberSlotClosed` can enumerate but the WRITES alone are still closed.
  assert.ok((invocationTargets(beforeDrawSource, beforeDrawMarker)?.length ?? 0) > 0)
})

test('closedCalleeBodiesOf refuses a written member slot the moment one write cannot be named', () => {
  for (const changed of [
    // A write of an ambient value: nothing this walk can enumerate.
    beforeDrawSource.replace(
      'instance.beforeDraw = function replacement(value: number) { return value + 1; };',
      'declare function external(value: number): number;\n  instance.beforeDraw = external;'
    ),
    // An intrinsic mutator reaching the family cannot be reduced to one value.
    beforeDrawSource.replace(
      'instance.beforeDraw = function replacement(value: number) { return value + 1; };',
      "Object.defineProperty(instance, 'beforeDraw', { value: function (value: number) { return value + 1; } });"
    ),
    // A compound assignment does not state what it installs.
    beforeDrawSource.replace(
      'instance.beforeDraw = function replacement(value: number) { return value + 1; };',
      'instance.beforeDraw ||= function replacement(value: number) { return value + 1; };'
    )
  ])
    assert.equal(closedCalleeBodies(changed, beforeDrawMarker), null, changed)
})

/** A loader shaped `loadBuffer( url, onLoad, nativeName )` that calls
 * `onLoad( nativeBuffer )` where `onLoad` is a PARAMETER, so the checker's
 * `getResolvedSignature` names the parameter's declared function TYPE, which
 * has no body. Every closed caller of `loadBuffer` supplies a compiled
 * function, so the callee's target set is closed even though no single
 * declaration names it. */
const loadBufferSource = `
  function loadBuffer(onLoad: (value: number) => void) { onLoad(1); }
  loadBuffer((value) => value);
  loadBuffer(function named(value) { return value; });`
const onLoadMarker = (call: ts.CallExpression): boolean => ts.isIdentifier(call.expression) && call.expression.text === 'onLoad'

test('closedCalleeBodiesOf admits a parameter callee whose every closed argument is a compiled function', () => {
  const closed = closedCalleeBodies(loadBufferSource, onLoadMarker)
  assert.equal(closed?.length, 2)
  assert.ok(closed?.some((target) => ts.isArrowFunction(target)))
  assert.ok(closed?.some((target) => ts.isFunctionExpression(target) && target.name?.text === 'named'))
})

test('closedCalleeBodiesOf refuses a parameter callee the moment a caller or its argument opens', () => {
  // One caller's argument is an ambient value this walk cannot name.
  const ambientArgument = loadBufferSource.replace(
    'loadBuffer(function named(value) { return value; });',
    'declare function external(value: number): void;\n  loadBuffer(external);'
  )
  assert.equal(closedCalleeBodies(ambientArgument, onLoadMarker), null)
  // `loadBuffer` itself escapes as a value, so its callers cannot all be named.
  const escapedOwner = `${loadBufferSource}
  declare function opaque(value: unknown): void;
  opaque(loadBuffer);`
  assert.equal(closedCalleeBodies(escapedOwner, onLoadMarker), null)
})

// The `states.get( key )` cache idiom: a factory (`makeCache`)
// returns a record whose `get` method memoizes into a native `Map` and
// returns another factory's own record. Nothing in `invocationTargetsOf`'s
// dispatch is new here -- `recordMethodCallTargetsOf` already names `get`'s
// own body for `cacheRecord.get('a')`, and `sourceRecordDataWritePlanOf`'s
// origin walk (`source-record-data.ts`) already threads a call receiver
// through a record method's own completions (the `lists.get(...)`
// worked example in that file's doc comment) and through a native `Map`'s
// stored values (`collectionStoredValuesOf`) for the memoization cache
// itself. This fixture exists to pin that chain end-to-end for the shape
// real programs have -- `currentState.setup(value)`, reached through
// `states.get(key)` -- rather than only the
// direct-factory shape the earlier tests in this file cover.
const cacheGetSource = `
  function makeRecord(): { setup(value: number): number } {
    return { setup(value) { return value } }
  }
  function makeCache() {
    const store = new Map<string, { setup(value: number): number }>()
    function get(key: string) {
      let entry = store.get(key)
      if (entry === undefined) {
        entry = makeRecord()
        store.set(key, entry)
      }
      return entry
    }
    return { get: get }
  }
  const cacheRecord = makeCache()
  const record = cacheRecord.get('a')
  record.setup(1)`
const setupMarker = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'setup'

test('closedCalleeBodiesOf admits a receiver reached through a closed cache .get() indirection', () => {
  const closed = closedCalleeBodies(cacheGetSource, setupMarker)
  assert.equal(closed?.length, 1)
  assert.ok(closed?.some((target) => ts.isMethodDeclaration(target) && target.name.getText() === 'setup'))
})

test('closedCalleeBodiesOf refuses a cache .get() indirection the moment a stored value is not closed', () => {
  // The cache fills from an ambient function instead of a compiled factory --
  // `store`'s stored-value set is no longer fully enumerable, so the whole
  // chain must fail closed rather than admit the one call site it can see.
  const ambientFill = cacheGetSource.replace(
    `function makeRecord(): { setup(value: number): number } {
    return { setup(value) { return value } }
  }`,
    `declare function makeRecord(): { setup(value: number): number };`
  )
  assert.equal(closedCalleeBodies(ambientFill, setupMarker), null)
  // The cache's own factory is closed, but the record it hands back is
  // replaced from outside before the call -- a stored value the cache
  // returned is no longer the only thing `record` can hold.
  const replacedAfterFill = `${cacheGetSource.replace(
    'record.setup(1)',
    `declare function replacement(value: number): number;
  record.setup = replacement;
  record.setup(1)`
  )}`
  assert.equal(closedCalleeBodies(replacedAfterFill, setupMarker), null)
})
