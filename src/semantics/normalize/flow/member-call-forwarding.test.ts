import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { closedCallableAuthorityOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { invocationValueContinuationsOf, invocationValueUsesOf } from './invocation-facts.js'
import { classConstructorKeepsInstanceOf } from './member-call-forwarding.js'
import { attachClosedScriptScope } from './targets.js'

const inspectFact = (
  source: string,
  receiverProven = true,
  scriptKind = ts.ScriptKind.JS,
  extraSources: Readonly<Record<string, string>> = {}
) => {
  const entry = resolve(`test/fixtures/closed-method-forwarding.${scriptKind === ts.ScriptKind.TS ? 'ts' : 'js'}`)
  const files = new Map(Object.entries(extraSources).map(([name, text]) => [resolve('test/fixtures', name), text]))
  files.set(entry, 'export {};\n' + source + (receiverProven ? '' : '\nglobalThis.external(held);'))
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => files.has(resolve(name)) || fileExists(name)
  host.getSourceFile = (name, version, ...rest) =>
    files.has(resolve(name))
      ? ts.createSourceFile(name, files.get(resolve(name))!, version, true, name.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : original(name, version, ...rest)
  const program = ts.createProgram([...files.keys()], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(
    checker,
    program.getSourceFiles().filter((file) => files.has(resolve(file.fileName))),
    wholeProgram
  )
  const argumentsObjects = censusArgumentsObjects(checker, [file])
  let call: ts.CallExpression | null = null
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'held.forward') call = node
    ts.forEachChild(node, walk)
  }
  walk(file)
  assert.ok(call)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const authority = closedCallableAuthorityOf(
    checker,
    flow,
    (value) => checker.getTypeAtLocation(value),
    (owner) => argumentsObjects.usesByOwner.get(owner)
  )
  const fact = ledger.capture(() => authority.invocationFactOf(call!)).value
  return fact
}

const inspect = (
  source: string,
  receiverProven = true,
  scriptKind = ts.ScriptKind.JS,
  extraSources: Readonly<Record<string, string>> = {}
) => {
  const fact = inspectFact(source, receiverProven, scriptKind, extraSources)
  return fact && fact.frames.every((frame) => frame.forwarding.kind === 'values') ? fact.frames : null
}

test('admitted invocation frames retain known outcomes when exact completion is unresolved', () => {
  for (const declaration of [
    'forward(choice) { if (choice) return { value: 1 }; return }',
    'forward(choice) { if (choice) return { value: 1 } }',
    'async forward(choice) { return { value: 1 } }',
    '*forward(choice) { yield { yielded: 2 }; return { value: 1 } }'
  ]) {
    const fact = inspectFact(`class Receiver { ${declaration} } const held = new Receiver(); held.forward(true);`)
    assert.ok(fact, declaration)
    const frame = fact.frames[0]!
    assert.equal(frame.completions.kind, 'unresolved', declaration)
    assert.deepEqual(
      frame.completionSummary?.values.map((value) => value.getText()),
      ['{ value: 1 }'],
      declaration
    )
  }
  const fact = inspectFact(`class Receiver {
    forward(choice) { if (choice) return { first: 1 }; else return { second: 2 } }
  } const held = new Receiver(); held.forward(true);`)
  assert.ok(fact)
  const frame = fact.frames[0]!
  assert.equal(frame.completions.kind, 'values')
  if (frame.completions.kind === 'values') assert.equal(frame.completions.values.length, 2)
})

test('method forwarding resolves factory aliases and every concrete inherited or replaced body', () => {
  const targets = inspect(`class Base { forward(value) { const alias = value; alias.hook(1) } }
    class Child extends Base {}
    function create() { return new Child() }
    const first = create(); const held = first;
    held.forward = (value) => value.hook(2);
    held.forward({ hook(value) {} });`)
  assert.ok(targets)
  assert.equal(targets.length, 2)
  assert.ok(targets.every((target) => target.parameters.length === 1))
  assert.ok(targets.some((target) => ts.isMethodDeclaration(target.body)))
  assert.ok(targets.some((target) => ts.isArrowFunction(target.body)))
  const family = inspect(`class Base { forward(value) { value.hook(1) } }
    class Child extends Base { forward(value) { value.hook(2) } }
    const held = Math.random() ? new Base() : new Child(); held.forward({ hook(value) {} });`)
  assert.equal(family?.length, 2)
  const stated = inspect(
    'class Receiver { forward(value: number) {} } function create(): Receiver { return new Receiver() } const held = create(); held.forward(1);',
    true,
    ts.ScriptKind.TS
  )
  assert.equal(stated?.length, 1)
})

test('method forwarding refuses missing closure, opaque replacements and accessor or constructor substitutions', () => {
  const base = 'class Receiver { forward(value) { value.hook(1) } } const held = new Receiver();'
  const call = 'held.forward({ hook(value) {} });'
  assert.equal(inspect(base + call, false), null)
  assert.equal(inspect(base + 'held.forward = globalThis.external;' + call), null)
  assert.equal(inspect(base + 'delete held.forward;' + call), null)
  assert.equal(inspect(base + 'Receiver.prototype.forward = (value) => value.hook(2);' + call), null)
  assert.equal(inspect('class Receiver { get forward() { return globalThis.external } } const held = new Receiver();' + call), null)
  assert.equal(
    inspect('class Receiver { constructor() { return globalThis.external } forward(value) {} } const held = new Receiver();' + call),
    null
  )
  assert.equal(inspect('const held = globalThis.external;' + call), null)
})

test('distinct concrete receiver classes can share one inherited forwarding body', () => {
  const targets = inspect(`class Base { forward(value) { value.hook(1) } }
    class Left extends Base {}
    class Right extends Base {}
    const held = Math.random() ? new Left() : new Right();
    held.forward({ hook(value) {} });`)
  assert.equal(targets?.length, 1)
  assert.equal(targets?.[0]?.parameters.length, 1)
})

test('complete forwarding frames include safe arguments reads and rest-array element continuations', () => {
  const argumentsFact = inspectFact(`class Receiver {
      forward(first, second) {
        arguments.length;
        for (let i = 0; i < arguments.length; i++) this.keep(arguments[i]);
      }
      keep(value) {}
    }
    const held = new Receiver(); held.forward({}, {}, {});`)
  assert.ok(argumentsFact)
  const argumentsFrame = argumentsFact.frames[0]!
  assert.equal(argumentsFrame.forwarding.kind, 'values')
  if (argumentsFrame.forwarding.kind === 'values') {
    const actuals = argumentsFrame.forwarding.entries.filter((entry) => argumentsFact.operands.args.includes(entry.value))
    assert.equal(actuals.length, 3)
    for (const entry of actuals) assert.ok(entry.uses.some((use) => use.getText() === 'arguments[i]'))
    const receiver = argumentsFrame.forwarding.entries.find((entry) => entry.value === argumentsFact.operands.receiver)
    assert.ok(receiver)
    assert.ok(receiver.uses.every((use) => use.kind === ts.SyntaxKind.ThisKeyword))
  }

  const restFact = inspectFact(
    'class Receiver { forward(...values) { this.keep(values[0]) } keep(value) {} } const held = new Receiver(); held.forward({}, {});'
  )
  assert.ok(restFact)
  const restFrame = restFact.frames[0]!
  assert.equal(restFrame.forwarding.kind, 'values')
  if (restFrame.forwarding.kind === 'values') {
    const actuals = restFrame.forwarding.entries.filter((entry) => restFact.operands.args.includes(entry.value))
    assert.equal(actuals.length, 2)
    for (const entry of actuals)
      assert.ok(entry.elementUses.some((use) => use.getText() === 'values' && use.parent.getText() === 'values[0]'))
    assert.equal(invocationValueUsesOf(restFact, restFact.operands.args[0]!), null)
    assert.ok(
      invocationValueContinuationsOf(restFact, restFact.operands.args[0]!)?.some(
        (continuation) => continuation.projection === 'array-element' && continuation.expression.parent.getText() === 'values[0]'
      )
    )
  }

  const escaped = inspectFact(
    'class Receiver { forward(value) { globalThis.external(arguments[0]) } } const held = new Receiver(); held.forward({});'
  )
  assert.ok(escaped)
  const escapedFrame = escaped.frames[0]!
  assert.equal(escapedFrame.forwarding.kind, 'values')
  if (escapedFrame.forwarding.kind === 'values')
    assert.ok(escapedFrame.forwarding.entries[0]?.uses.some((use) => use.getText() === 'arguments[0]'))
})

test('forwarding refuses unknown arguments-object uses, frame writes and destructured formals', () => {
  for (const body of [
    'forward(value) { globalThis.external(arguments) }',
    'forward(value) { arguments[0] = value }',
    'forward(value) { (arguments[0]) = value }',
    'forward(value) { arguments.length = 0 }',
    'forward({ value }) { void value }',
    'forward(...[value]) { void value }'
  ]) {
    assert.equal(inspect(`class Receiver { ${body} } const held = new Receiver(); held.forward({});`), null)
  }
})

test('invocation continuations preserve distinct nodes at matching positions across source files', () => {
  const extraSources = {
    'first-target.ts': 'export class First { forward(value) { value.hook(); } }',
    'second-target.ts': 'export class Other { forward(value) { value.hook(); } }'
  }
  const fact = inspectFact(
    `import { First } from './first-target'; import { Other } from './second-target';
     const held = Math.random() ? new First() : new Other(); held.forward({ hook() {} });`,
    true,
    ts.ScriptKind.TS,
    extraSources
  )
  assert.ok(fact)
  assert.equal(fact.frames.length, 2)
  const value = fact.operands.args[0]!
  const continuations = invocationValueContinuationsOf(fact, value)
  assert.equal(continuations?.length, 2)
  assert.notEqual(continuations?.[0]?.expression, continuations?.[1]?.expression)
  assert.equal(continuations?.[0]?.expression.pos, continuations?.[1]?.expression.pos)
  assert.equal(continuations?.[0]?.expression.end, continuations?.[1]?.expression.end)
  assert.notEqual(continuations?.[0]?.expression.getSourceFile(), continuations?.[1]?.expression.getSourceFile())
})

test('actual module namespace constructors retain exact origins without accepting mutable lookalikes', () => {
  const module = { 'namespace-origin.ts': 'export class Receiver { forward(value: unknown) {} }' }
  for (const constructor of ['api.Receiver', 'api["Receiver"]']) {
    assert.equal(
      inspect(
        `import * as api from './namespace-origin'; const held = new ${constructor}(); held.forward(1);`,
        true,
        ts.ScriptKind.TS,
        module
      )?.length,
      1
    )
  }
  assert.equal(
    inspect(
      `import { Receiver } from './namespace-origin'; const api = { Receiver }; const held = new api.Receiver(); held.forward(1);`,
      true,
      ts.ScriptKind.TS,
      module
    ),
    null
  )
})

test('closed direct function arguments preserve exact receiver origins across parameter aliases', () => {
  const receiver = 'class Receiver { forward(value: object) {} } '
  assert.equal(
    inspect(
      receiver + 'function invoke(held: Receiver, value: object) { held.forward(value) } invoke(new Receiver(), {});',
      true,
      ts.ScriptKind.TS
    )?.length,
    1
  )
  assert.equal(
    inspect(receiver + 'function invoke(held: Receiver = new Receiver()) { held.forward({}) } invoke();', true, ts.ScriptKind.TS)?.length,
    1
  )
  for (const suffix of [
    'export function invoke(held: Receiver) { held.forward({}) } invoke(new Receiver());',
    'declare function foreign(): Receiver; function invoke(held: Receiver) { held.forward({}) } invoke(foreign());',
    'declare function external(value: unknown): void; function invoke(held: Receiver) { held.forward({}) } external(invoke); invoke(new Receiver());',
    'declare function external(value: unknown): void; function invoke(held: Receiver) { external(arguments); held.forward({}) } invoke(new Receiver());'
  ])
    assert.equal(inspect(receiver + suffix, true, ts.ScriptKind.TS), null, suffix)
})

test('conditional construction records every actual source class and refuses escaping constructor selections', () => {
  const prefix = 'class First { forward(value) {} } class Second { forward(value) {} }'
  const construct = 'const held = new (Math.random() ? First : Second)(); held.forward(1);'
  const targets = inspect(prefix + construct)
  assert.equal(targets?.length, 2)
  assert.deepEqual(
    targets
      ?.map((target) =>
        ts.isMethodDeclaration(target.body) && ts.isClassLike(target.body.parent) ? (target.body.parent.name?.text ?? null) : null
      )
      .sort(),
    ['First', 'Second']
  )
  assert.equal(inspect(prefix + 'globalThis.external(Math.random() ? First : Second);' + construct), null)
  assert.equal(inspect(prefix + 'Second.prototype.forward = globalThis.external;' + construct), null)
  assert.equal(
    inspect('class First { forward(value) {} } const held = new (Math.random() ? First : globalThis.external)(); held.forward(1);'),
    null
  )
  assert.equal(
    inspect('class First { forward(value) {} } class Second { constructor(){return globalThis.external} forward(value) {} }' + construct),
    null
  )
})

test('a constructor-function member declared `this.x = namedFunction` forwards exactly like a class method', () => {
  const factory = 'function Factory() { function helper(value) { value.hook(1) } this.forward = helper } '
  const targets = inspect(factory + 'const held = new Factory(); held.forward({ hook(value) {} });')
  assert.equal(targets?.length, 1)
  assert.ok(targets?.every((target) => ts.isFunctionDeclaration(target.body)))
  // A helper rebound after being stored is not a stable slot.
  assert.equal(
    inspect(
      'function Factory() { function helper(value) { value.hook(1) } this.forward = helper; helper = function (value) { value.hook(2) } } ' +
        'const held = new Factory(); held.forward({ hook(value) {} });'
    ),
    null
  )
  // The same assignment shape on a plain object -- not `this` of a source
  // constructor function -- is a different question this arm does not answer.
  assert.equal(
    inspect('function helper(value) { value.hook(1) } const held = {}; held.forward = helper; held.forward({ hook(value) {} });'),
    null
  )
})

/** Whether the class named `Owner` keeps its instance, for a program given as source text. */
const keepsInstance = (source: string): boolean => {
  const entry = resolve('test/fixtures/class-constructor-keeps-instance.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(flow, { files: new Set([file]) })
  const owner = flow.classDeclarations.find((declaration) => declaration.name?.text === 'Owner')
  assert.ok(owner?.name)
  const symbol = checker.getSymbolAtLocation(owner.name)
  assert.ok(symbol)
  const type = checker.getDeclaredTypeOfSymbol(symbol)
  assert.ok(type.isClassOrInterface())
  return classConstructorKeepsInstanceOf(checker, flow, type)
}

test('a class binding handed to a source call is forwarded into its parameter, not treated as escaped', () => {
  // `mount(App)` — `@geastack/core`'s own `primitives.ts` — is a call to an
  // ORDINARY source function whose parameter is used only as `new component()`.
  // This inventory accepted `new`, heritage, imports, static data,
  // prototype-method identity, `===` and `instanceof`, and refused every call
  // argument, so handing a class to a function in the same program opened its
  // whole receiver family and with it every `this.method(...)` in the class.
  // The forwarding was never unknown; the walk stopped at the call.
  const owner = 'class Owner { draw(value: number) { return value } }'
  assert.equal(keepsInstance(`${owner} function mount(c: new () => Owner): void { void new c() } mount(Owner);`), true)
  assert.equal(
    keepsInstance(
      `${owner} function inner(c: new () => Owner): void { void new c() }
       function outer(c: new () => Owner): void { inner(c) } outer(Owner);`
    ),
    true,
    'two hops of the same forwarding'
  )

  // The callee is held to the standard the class binding itself is held to,
  // and the parameter to the standard every other inventoried cell is.
  for (const [why, program] of [
    ['a bodiless callee has no parameter to inventory', `${owner} declare function mount(c: new () => Owner): void; mount(Owner);`],
    [
      'the parameter is handed on to unknown code',
      `${owner} declare function sink(value: unknown): void;
       function mount(c: new () => Owner): void { sink(c) } mount(Owner);`
    ],
    [
      'the callee replaces a prototype slot through the parameter',
      `${owner} declare function other(value: number): number;
       function mount(c: new () => Owner): void { c.prototype.draw = other } mount(Owner);`
    ],
    [
      'the parameter is reassigned, so its later contents were never seen',
      `${owner} declare function pick(): new () => Owner;
       function mount(c: new () => Owner): void { c = pick(); void new c() } mount(Owner);`
    ],
    [
      'a spread leaves every later argument in an unknown slot',
      `${owner} function mount(c: new () => Owner): void { void new c() }
       const args: [new () => Owner] = [Owner]; mount(...args);`
    ],
    [
      'a rest parameter holds the argument as an array element',
      `${owner} function mount(...cs: (new () => Owner)[]): void { void new cs[0]!() } mount(Owner);`
    ],
    [
      'a callee that is not a plain name is more than one possible body',
      `${owner} function one(c: new () => Owner): void { void new c() }
       function two(c: new () => Owner): void { void new c() }
       declare const flag: boolean; (flag ? one : two)(Owner);`
    ],
    [
      'a reassigned callee binding is more than one possible body',
      `${owner} function one(c: new () => Owner): void { void new c() }
       function two(c: new () => Owner): void { void new c() }
       let pick = one; pick = two; pick(Owner);`
    ],
    [
      'the parameter is published on the global object',
      `${owner} function mount(c: new () => Owner): void { (globalThis as unknown as { slot: unknown }).slot = c } mount(Owner);`
    ],
    // The frame states this as `arguments-object`, and it is the reason this
    // step reads the frame instead of a position in `call.arguments`: the
    // parameter is never mentioned, so a walk that inventoried only the
    // parameter found nothing to explain and answered closed.
    [
      'the callee reaches the argument through its own arguments object',
      `${owner} declare function other(value: number): number;
       function mount(c: new () => Owner): void {
         void c
         ;(arguments[0] as new () => Owner).prototype.draw = other
       }
       mount(Owner);`
    ]
  ] as const)
    assert.equal(keepsInstance(program), false, why)
})

test('mutually recursive forwarding converges instead of answering an in-progress cell', () => {
  // Two bodies hand the same class binding to each other. A recursive descent
  // needs an "already visiting" answer here, and both spellings are wrong:
  // `true` invents closure for a cell nobody inventoried, `false` refuses a
  // program whose every cell IS inventoried. The closure is a worklist, so the
  // second hop finds the cell already scheduled and the fixpoint decides.
  const owner = 'class Owner { draw(value: number) { return value } }'
  assert.equal(
    keepsInstance(
      `${owner} declare const flag: boolean
       function ping(c: new () => Owner): void { if (flag) pong(c); else void new c() }
       function pong(c: new () => Owner): void { if (flag) ping(c); else void new c() }
       ping(Owner);`
    ),
    true
  )
  assert.equal(
    keepsInstance(
      `${owner} declare const flag: boolean
       declare function sink(value: unknown): void
       function ping(c: new () => Owner): void { if (flag) pong(c); else void new c() }
       function pong(c: new () => Owner): void { if (flag) ping(c); else sink(c) }
       ping(Owner);`
    ),
    false,
    'a leak anywhere in the cycle still refuses'
  )
})
