import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'
import { compile } from '../../compiler.js'

const infer = (observation: string) => {
  const entry = resolve('test/fixtures/array-backlink-member.js')
  const source = `export {};
    class Renderer { constructor() { this.draw = function(input) { return input.amount; }; } }
    class Part { /** @type {Target|null} */ owner = null; marker = 1; }
    class Target {
      parts = [new Part()];
      constructor() { this.parts[0].owner = this; this.part = this.parts[0]; }
      /** @param {Renderer} renderer */
      render(renderer) { renderer.draw({amount:7}); }
    }
    const held = new Renderer(); const target = new Target();
    target.render(held);
    ${observation}
  `
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const index = indexParameterBindingProgram(checker, [file], wholeProgram)
  attachDeferredIntrinsicProtocolLedger(index.valueFlow, createDeferredIntrinsicProtocolLedger())
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index)
  let callback: ts.FunctionExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node)) callback = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(callback)
  return { checker, type: census.typeAt(callback.parameters[0]!), debug: census.debugReport?.() }
}

test('indexed owner backlinks retain their complete array and containing-field continuation', () => {
  const result = infer('const part = target.parts[0]; console.log(part.marker, target.part.marker);')
  assert.ok(result.type, result.debug)
  const amount = result.checker.getPropertyOfType(result.type, 'amount')
  assert.ok(amount)
  assert.ok((result.checker.getTypeOfSymbolAtLocation(amount, amount.valueDeclaration!).flags & ts.TypeFlags.NumberLike) !== 0)
})

const refused = (type: ts.Type | null | undefined): boolean => !type || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0

test('an owner stored below a nested element, a nested container or a read binding cannot hide its escape', () => {
  // Each setup alone keeps the frame closed; the escape appended to it must
  // open it. A walk that cut a repeated hop, never descended a second element
  // hop, or walked only the binding a store named would miss each escape.
  // The nested-grid control is still refused (open precision gap: the walk
  // stops at `grid[0][0].owner` under a repeated-element summary), so only
  // its escape is asserted.
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['const grid = [[new Part()]]; grid[0][0].owner = held; console.log(grid.length);', 'globalThis.unknownConsumer(grid);', false],
    [
      'const inner = { parts: [new Part()] }; inner.parts[0].owner = held; const outer = { owner: null }; outer.owner = inner;',
      'globalThis.unknownConsumer(outer);',
      true
    ],
    [
      'const leaves = [new Part()]; const leaf = leaves[0]; leaf.owner = held; console.log(leaves.length);',
      'globalThis.unknownConsumer(leaves[0].owner);',
      true
    ]
  ]
  for (const [setup, escape, binds] of cases) {
    const control = infer(setup)
    if (binds) assert.ok(!refused(control.type), `control: ${setup}\n${control.debug}`)
    assert.ok(refused(infer(`${setup} ${escape}`).type), escape)
  }
})

test('a call through a base-typed receiver enters every override', () => {
  const source = (override: string) =>
    `class A { m(x) { console.log(x === null); } } class B extends A { m(x) { ${override} } }
    /** @param {A} receiver */ function run(receiver) { receiver.m(held); } run(new B());`
  const control = infer(source('console.log(x === null);'))
  assert.ok(!refused(control.type), control.debug)
  assert.ok(refused(infer(source('globalThis.unknownConsumer(x);')).type))
})

test('a method slot cannot be replaced through a sibling or entered through a look-alike receiver', () => {
  // `run` states an `A`; JavaScript hands it anything with an `m`, and every
  // shape below names `A.m` to the checker while running its own function.
  const setup = `class A { m(x) { console.log(x === null); } }
    /** @param {A} receiver */ function run(receiver) { receiver.m(held); }
    const a = new A(); a.m(held); run(new A());`
  const control = infer(setup)
  assert.ok(!refused(control.type), control.debug)
  const sink = 'function (x) { globalThis.unknownConsumer(x); }'
  for (const escape of [
    'const sibling = new A(); globalThis.unknownConsumer(sibling);',
    'run({ m(x) { globalThis.unknownConsumer(x); } });',
    `function F() {} F.prototype.m = ${sink}; run(new F());`,
    `function F() {} F.prototype = Object.create(A.prototype); F.prototype.m = ${sink}; run(new F());`,
    'const fake = { m(x) { globalThis.unknownConsumer(x); } }; Object.setPrototypeOf(fake, A.prototype); run(fake);',
    'run({ __proto__: A.prototype, m(x) { globalThis.unknownConsumer(x); } });',
    `function inherits(c, p) { c.prototype = Object.create(p.prototype); } function F() {} inherits(F, A); F.prototype.m = ${sink}; run(new F());`,
    `A.prototype.m = ${sink};`,
    `Object.getPrototypeOf(a).m = ${sink};`,
    'Object.assign(A.prototype, { m(x) { globalThis.unknownConsumer(x); } });',
    // A function-constructor family (three's old `EventDispatcher` mixins):
    // nothing here can name its overrides, so it refuses outright.
    `function E() {} Object.assign(E.prototype, { m(x) { console.log(x === null); } });
      function G() {} Object.assign(G.prototype, E.prototype, { m: ${sink} });
      /** @param {E} r */ function runE(r) { r.m(held); } runE(new E()); runE(new G());`
  ])
    assert.ok(refused(infer(`${setup} ${escape}`).type), escape)
})

/** The census type of the one parameter spelled `input` in a bare fixture. */
const inputType = (body: string): ts.Type | null | undefined => {
  const entry = resolve('test/fixtures/array-backlink-member-input.js')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, `export {};\n${body}`, version, true, ts.ScriptKind.JS)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const index = indexParameterBindingProgram(checker, [file], wholeProgram)
  attachDeferredIntrinsicProtocolLedger(index.valueFlow, createDeferredIntrinsicProtocolLedger())
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index)
  let input: ts.ParameterDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'input') input = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(input)
  return census.typeAt(input)
}

// `parameter-bindings.ts` binds a METHOD's parameters only once the member
// proof has walked every construction of its family, not just the mentions.
test('a sibling instance handed to unknown code opens its methods parameters', () => {
  const setup = 'class A { m(input) { return input.amount; } } const a = new A(); a.m({ amount: 7 });'
  assert.ok(!refused(inputType(setup)))
  assert.ok(refused(inputType(`${setup} const sibling = new A(); globalThis.unknownConsumer(sibling);`)))
})

test('a native class-typed slot refuses an unrelated instance or a look-alike record end to end', () => {
  // The invariant the receiver walk's declared-type arms rest on: a class-ref
  // carrier is nominal. A JSDoc `@param {A}` handed an unrelated `new B()` with
  // the same members, or a record that looks like an `A`, has no conversion
  // into `A`'s carrier, so certification refuses the program rather than
  // emitting a call that enters `A.m` on a `B`.
  const file = resolve('test/runtime/nominal-class-carrier.js')
  const certify = (lines: readonly string[]) =>
    compile({
      rootFileNames: [file],
      javaScriptSources: true,
      statedModuleSet: true,
      sourceOverlay: new Map([[file, `${lines.join('\n')}\n`]])
    })
  const declare = (name: string, tag: number, body: string) => [
    `class ${name} {`,
    `  constructor() { this.tag = ${tag} }`,
    '  /** @param {number} x */',
    `  m(x) { return ${body} }`,
    '}'
  ]
  const run = ['/** @param {A} receiver */', 'function run(receiver) { return receiver.m(1) }', 'console.log(run(new A()))']
  const control = certify([...declare('A', 1, 'x + 1'), ...run])
  assert.ok(control.certificate && control.source, JSON.stringify(control.refusals))
  const unrelated = certify([...declare('A', 1, 'x + 1'), ...declare('B', 2, 'x * 2'), ...run, 'console.log(run(new B()))'])
  assert.equal(unrelated.certificate, null)
  assert.ok(
    unrelated.refusals.some(
      (refusal) => refusal.stage === 'certify' && /no runtime conversion is installed from class-ref/.test(refusal.reason)
    ),
    JSON.stringify(unrelated.refusals)
  )
  const lookAlike = certify([
    ...declare('A', 1, 'x + 1'),
    ...run,
    'console.log(run({ tag: 3, /** @param {number} x */ m(x) { return x - 1 } }))'
  ])
  assert.equal(lookAlike.certificate, null)
  assert.ok(
    lookAlike.refusals.some((refusal) => refusal.stage === 'certify'),
    JSON.stringify(lookAlike.refusals)
  )
})

test('a value used only as a closed native map key stays closed; a map that yields keys does not', () => {
  // Three's `WebGLObjects.update`: `updateMap.get( object ) !== frame`, then
  // `updateMap.set( object, frame )` -- the drawable is only ever a key.
  const setup = 'const seen = new WeakMap(); if (seen.get(held) !== 1) seen.set(held, 1); console.log(seen.has(held));'
  const control = infer(setup)
  assert.ok(!refused(control.type), control.debug)
  for (const escape of [
    'globalThis.unknownConsumer(seen);',
    'const keyed = new Map(); keyed.set(held, 1); globalThis.unknownConsumer([...keyed.keys()]);',
    'const keyed = new Map(); keyed.set(held, 1); keyed.forEach((value, key) => globalThis.unknownConsumer(key));'
  ])
    assert.ok(refused(infer(`${setup} ${escape}`).type), escape)
})

test('an argument to a member call on a receiver that is only ever nullish is never handed over', () => {
  // Three's `let _nodesHandler = null`, assigned only by a `setNodesHandler`
  // nothing calls, then `_nodesHandler.renderStart( scene, camera )`.
  const setters = 'let handler = null; function setHandler(h) { handler = h; }'
  const cases: readonly (readonly [string, string])[] = [
    [`${setters} if (handler !== null) handler.consume(held);`, 'setHandler({ consume: (x) => globalThis.unknownConsumer(x) });'],
    [
      'function drive(handler) { if (handler) handler.consume(held); } drive(null); drive();',
      'drive({ consume: (x) => globalThis.unknownConsumer(x) });'
    ]
  ]
  for (const [setup, escape] of cases) {
    const control = infer(setup)
    assert.ok(!refused(control.type), `control: ${setup}\n${control.debug}`)
    assert.ok(refused(infer(`${setup} ${escape}`).type), escape)
  }
  for (const open of [
    'for (const handler of globalThis.handlers) handler.consume(held);',
    'var handler = null; var handler = { consume: (x) => globalThis.unknownConsumer(x) }; handler.consume(held);'
  ])
    assert.ok(refused(infer(open).type), open)
})

// Three's `EventDispatcher.dispatchEvent`: `array[ i ].call( this, event )`.
const listenerSetup =
  'function listener(event) { console.log(this === null, event); } const listeners = [listener]; for (let i = 0; i < listeners.length; i++) listeners[i].call(held, i);'
// `callableArrayTargetsOf` closes an element read of the listener array as a
// direct callee (`listeners[ i ]( event )`), a delete, a store -- and as the
// receiver of the intrinsic `.call`, which is the spelling three actually
// uses. So the frame resolves here rather than refusing.
test('a receiver handed to array-held listeners as this is followed into each listener', () => {
  const control = infer(listenerSetup)
  assert.ok(!refused(control.type), control.debug)
})

test('a receiver handed to array-held listeners as this refuses wherever a listener can publish it', () => {
  const setup = listenerSetup
  for (const escape of [
    'function leaker() { globalThis.unknownConsumer(this); } listeners.push(leaker);',
    'function nested() { const later = () => globalThis.unknownConsumer(this); later(); } listeners.push(nested);',
    'function second(a, b) { globalThis.unknownConsumer(b); } listeners.push(second); listeners[0].call(null, 1, held);',
    'listeners.push(globalThis.unknownConsumer);'
  ])
    assert.ok(refused(infer(`${setup} ${escape}`).type), escape)
})

test('an array element backlink or array container cannot hide its owner escaping', () => {
  for (const observation of [
    'globalThis.unknownConsumer(target.parts[0].owner);',
    'globalThis.unknownConsumer(target.parts);',
    'globalThis.unknownConsumer(target.part.owner);'
  ]) {
    const result = infer(observation)
    assert.ok(!result.type || (result.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0, observation)
  }
})
