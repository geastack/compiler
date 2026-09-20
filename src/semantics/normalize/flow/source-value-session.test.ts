import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { indexValueFlow } from './value-flow.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

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
  return { bodyTexts, checker, file, flow, session, targetCall }
}

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
  assert.equal(externalOwner.bodyTexts(externalOwner.targetCall('/* target */', 'owner.slot.run')), null)

  const externalSlot = inspect(
    `${base} declare function external(value: unknown): void; external(owner.slot); /* target */ owner.slot.run(owner);`
  )
  assert.equal(externalSlot.bodyTexts(externalSlot.targetCall('/* target */', 'owner.slot.run')), null)

  const opaqueSlot = inspect(`${base} declare function getSlot(): unknown; owner.slot = getSlot(); /* target */ owner.slot.run(owner);`)
  assert.equal(opaqueSlot.bodyTexts(opaqueSlot.targetCall('/* target */', 'owner.slot.run')), null)
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
  assert.equal(unknown.bodyTexts(unknown.targetCall('/* target */', 'owner.slot.run')), null)

  const opaqueFunction = inspect(`
    class Owner { value = 4; slot = { run(owner) { return owner.value + 1 } }; }
    const owner = new Owner();
    const alias = owner.slot;
    declare const unknownRun: (owner: Owner) => number;
    alias.run = unknownRun;
    /* target */ owner.slot.run(owner);
  `)
  assert.equal(opaqueFunction.bodyTexts(opaqueFunction.targetCall('/* target */', 'owner.slot.run')), null)
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
  assert.equal(escaped.bodyTexts(escaped.targetCall('/* escaped construction */', 'owner.slot.run')), null)
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
  assert.equal(escaped.bodyTexts(escapedCall), null)
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
    assert.equal(values[0]!.getText(checked.file), expected, marker)
  }
  const left = checked.session.valuesOf(checked.targetCall('/* left */', 'left.read'))![0]
  const right = checked.session.valuesOf(checked.targetCall('/* right */', 'right.read'))![0]
  assert.notEqual(left, right)
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
  // three's own `WebGLRenderer` destructures its whole options bag with a
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
    assert.equal(checked.bodyTexts(checked.targetCall(marker, callee)), null, why)
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
    assert.equal(checked.bodyTexts(checked.targetCall('/* target */', callee)), null, why)
  }
})

test('a getter read on a construction resolves through the setter that stores its backing field', () => {
  // `source.depthTexture` in three's `RenderTarget.copy` is a getter over
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

test("Object.assign copies each source's own slot values into the target it returns", () => {
  // `bulkAssignOf`: the intact `Object.assign(target, ...sources)` evaluates
  // to its target, and each source's own value under a key lands in the
  // target's slot beside whatever the target already spelled there --
  // three's `RenderTarget` builds its `options` exactly this way. A second
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
