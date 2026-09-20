import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'

const infer = (
  extra: string,
  objectLiteral = false,
  named = false,
  callbackBody = 'return third.value',
  factory = false,
  scope: 'closed' | 'open' = 'closed'
) => {
  const source = `
    class Matrix { elements = [1, 2, 3]; copy() { return this } }
    class Base { hook() {} noop() {} valueOf() { globalThis.unknownConsumer(this); return 1 } self = this; matrix = new Matrix() }
    class Child extends Base {}
    function dispatch(target, first, second, third) { target.hook(first, second, third, 41) }
    ${factory ? 'function makeObject() {' : ''}
    ${
      objectLiteral
        ? 'const object = { hook: (first, second, third) => third.value };'
        : `const object = new Child(); object.hook = function ${named ? 'replacement' : ''}(first, second, third) { ${callbackBody} };`
    }
    ${factory ? 'return object; } const object = makeObject();' : ''}
    ${extra}
    dispatch(object, { renderer: 1 }, { scene: 2 }, { value: 7 });
  `
  return inferSource(source, scope)
}

const inferSource = (source: string, scope: 'closed' | 'open' = 'closed') => {
  const entry = resolve('test/fixtures/mutable-method-parameters.js')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  // Every fixture here is the whole program: one script file, nothing else
  // reachable. Without stating that, `localBindingWritesAreComplete`
  // (`flow/value-provenance.ts`) treats every top-level `const`/`let` as a
  // classic-script global an unseen sibling script could also write, and the
  // whole receiver census refuses before it starts -- not the defect this
  // suite exists to catch. `closed-callable-authority.test.ts` and
  // `member-call-forwarding.test.ts` already state this same boundary for the
  // identical reason.
  //
  // `scope: 'open'` is the one deliberate exception: a fixture that asks what
  // a classic script must refuse when an unseen sibling script CAN reach its
  // globals. Stating the closed boundary there would turn the boundary the
  // test exists to probe into the very thing the census is told to assume.
  const valueFlow = indexValueFlow(checker, [file], wholeProgram)
  if (scope === 'closed') attachClosedScriptScope(valueFlow, { files: new Set([file]) })
  const index = indexParameterBindingProgram(checker, [file], wholeProgram, valueFlow)
  const census = censusParameterBindings(checker, [file], wholeProgram, undefined, index, valueFlow)
  let callback: ts.FunctionExpression | ts.ArrowFunction | undefined
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
      (ts.isBinaryExpression(node.parent) || ts.isPropertyAssignment(node.parent))
    )
      callback = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(callback)
  return { checker, types: callback.parameters.map((parameter) => census.typeAt(parameter)), debug: census.debugReport?.() ?? '' }
}

test('inline mutable method parameters receive typed arguments through an inferred receiver', () => {
  const { checker, types } = infer('')
  for (const [index, member] of ['renderer', 'scene', 'value'].entries()) {
    const type = types[index]
    assert.ok(type && checker.getPropertyOfType(type, member), `parameter ${index} retains ${member}`)
  }
})

test('method identity comparisons through local aliases do not create unknown callers', () => {
  const { checker, types } = infer('const saved = object.hook; console.log(saved === object.hook);')
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('a callback handed to an unknown consumer cannot infer its frame from a partial caller set', () => {
  const { types, debug } = infer('globalThis.unknownConsumer(object.hook);')
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
  assert.ok(debug.includes('; receiver '), 'the failed use remains attributed after final census sealing')
})

test('inline object member publication retains the same unknown-consumer escape boundary', () => {
  const { types } = infer('globalThis.unknownConsumer(object.hook);', true)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a named inline replacement keeps its own recursion name separate from the published member identity', () => {
  const { checker, types } = infer('', false, true)
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('whole receiver escapes cannot infer callback parameters from only visible member calls', () => {
  for (const extra of [
    'globalThis.unknownConsumer(object);',
    'const alias = object; globalThis.unknownConsumer(alias);',
    'const bag = { object }; globalThis.unknownConsumer(bag);',
    'globalThis.unknownConsumer(object.self);',
    'function escape(value) { globalThis.unknownConsumer(value) } escape(object);',
    'object.hook = globalThis.externalHook;'
  ]) {
    const { types } = infer(extra)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      extra
    )
  }
})

test('a known forwarding helper keeps receiver uses closed', () => {
  const { checker, types } = infer(
    'function inspect(value) { const alias = value; console.log(alias.hook === value.hook) } inspect(object);'
  )
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('dynamic this and nested lexical arrows cannot hide a containing receiver escape', () => {
  for (const body of [
    'globalThis.unknownConsumer(this); return third.value',
    'const use = () => globalThis.unknownConsumer(this); use(); return third.value'
  ]) {
    const { types } = infer('', false, false, body)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      body
    )
  }
})

test('a nested ordinary function owns its own receiver separately from the method callback', () => {
  const { checker, types } = infer('', false, false, 'function unrelated() { return this } return third.value')
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('a closed factory result carries the same complete receiver use proof', () => {
  const { checker, types } = infer('', false, false, 'return third.value', true)
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('an escaping factory or one escaping result does not prove a closed receiver', () => {
  for (const extra of ['globalThis.unknownConsumer(makeObject)', 'globalThis.unknownConsumer(makeObject())']) {
    const { types } = infer(extra, false, false, 'return third.value', true)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      extra
    )
  }
})

test('nested named containers retain a closed path to the method receiver', () => {
  const { checker, types } = infer(
    'const holder = { buffers: { color: object } }; dispatch(holder.buffers.color, {renderer:1}, {scene:2}, {value:7});'
  )
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('an escaping containing object still exposes its nested method receiver', () => {
  const { types } = infer('const holder = { buffers: { color: object } }; globalThis.unknownConsumer(holder);')
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('an object-valued field with an owner back-reference remains an open escape', () => {
  const { types } = infer('object.matrix.parent = object; globalThis.unknownConsumer(object.matrix);')
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a sibling method with a closed receiver body does not leak the method owner', () => {
  const { checker, types } = infer('object.noop();')
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('a sibling method replaced by external code does not have a closed receiver body', () => {
  const { types } = infer('object.noop = globalThis.externalMethod; object.noop();')
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('coercive comparisons are receiver uses that may invoke external hooks', () => {
  for (const extra of ['console.log(object == 1)', 'console.log(object < 2)', 'console.log(object instanceof globalThis.External)']) {
    const { types } = infer(extra)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      extra
    )
  }
})

test('strict object identity comparisons do not execute coercion hooks', () => {
  const { checker, types } = infer('console.log(object === object, object !== null)')
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('a checker-attributed helper reached through a replaced alias is not a closed receiver sink', () => {
  const { types } = infer('function inspect(value) {} let alias = inspect; alias = globalThis.external; alias(object)')
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('implicit arguments cannot hide forwarded receiver uses from the parameter inventory', () => {
  for (const extra of [
    'function forward(value) { globalThis.unknownConsumer(arguments[0]) } forward(object)',
    'function forward(value) { const use = () => globalThis.unknownConsumer(arguments[0]); use() } forward(object)'
  ]) {
    const { types } = infer(extra)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      extra
    )
  }
})

test('ordinary JavaScript constructor data writes keep a closed callback receiver', () => {
  for (const initialization of ['this.flag = true;', 'this.cache = {};']) {
    const { checker, types } = inferSource(`
      class Renderer { constructor() {
        ${initialization}
        this.hook = function(value) { return value.amount };
      } }
      const renderer = new Renderer();
      renderer.hook({ amount: 3 });
    `)
    assert.ok(types[0] && checker.getPropertyOfType(types[0], 'amount'), initialization)
  }
})

test('a derived accessor cannot disguise an executing constructor assignment as a data write', () => {
  const { types } = inferSource(`
    class Renderer { constructor() {
      this.flag = true;
      this.hook = function(value) { return value.amount };
    } }
    class Derived extends Renderer { set flag(value) { globalThis.unknownConsumer(this) } }
    const renderer = new Derived();
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a closed class method can inspect a forwarded callback owner', () => {
  const { checker, types } = infer(`
    export {};
    class Inspector { inspect(value) { console.log(value.hook === value.hook) } }
    const inspector = new Inspector();
    inspector.inspect(object);
  `)
  assert.ok(types[2] && checker.getPropertyOfType(types[2], 'value'))
})

test('a script-global helper receiver is not a private forwarding implementation', () => {
  // A const binding cannot be reassigned, but another script can still name
  // its object and replace the method. The positive case is module-private,
  // and the closed-scope harness above would make this script private too:
  // the boundary under test is the OPEN one.
  const { types } = infer(
    `
    class Inspector { inspect(value) { console.log(value.hook === value.hook) } }
    const inspector = new Inspector();
    inspector.inspect(object);
  `,
    false,
    false,
    'return third.value',
    false,
    'open'
  )
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('an escaped method receiver cannot promise its original forwarding body', () => {
  const { types } = infer(`
    class Inspector { inspect(value) { console.log(value.hook === value.hook) } }
    const inspector = new Inspector();
    globalThis.unknownConsumer(inspector);
    inspector.inspect(object);
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('source-closed constructor fields can be read without publishing their owner', () => {
  const { checker, types } = inferSource(`
    class Matrix { value = 3 }
    class Renderer { matrix = new Matrix(); hook() {} }
    const renderer = new Renderer();
    renderer.hook = function(value) { return value.amount };
    console.log(renderer.matrix.value);
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types[0] && checker.getPropertyOfType(types[0], 'amount'))
})

test('an instance without visible method calls still contributes constructor publications', () => {
  const { types } = inferSource(`
    class Renderer { self = this; data = { value: 3 }; hook() {} }
    const renderer = new Renderer();
    renderer.hook = function(value) { return value.amount };
    console.log(renderer.data.value);
    const unseen = new Renderer();
    globalThis.unknownConsumer(unseen.self);
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a constructor can install a nested callback container through a this alias', () => {
  // A module: the question is the `this` alias inside the constructor. As a
  // classic script, `makeBuffer` would be a global-object property, which the
  // closed script scope deliberately does not make private (SEMANTIC-AUTHORITY
  // §4), and the graph would refuse the factory's result before the alias
  // was ever asked.
  const { checker, types } = inferSource(`
    export {};
    function makeBuffer() { return { hook: function(value) { return value.amount } } }
    class Renderer { constructor() {
      const self = this;
      const state = { buffer: makeBuffer() };
      self.state = state;
      this.flag = true;
    } }
    const renderer = new Renderer();
    renderer.state.buffer.hook({ amount: 3 });
  `)
  assert.ok(types[0] && checker.getPropertyOfType(types[0], 'amount'))
})

test('a constructor prototype setter is not an ordinary data installation', () => {
  const { types } = inferSource(`
    class Renderer { constructor() {
      this.__proto__ = globalThis.externalPrototype;
      this.hook = function(value) { return value.amount };
    } }
    const renderer = new Renderer();
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a local native map preserves the complete callback-owner continuation', () => {
  const { checker, types } = inferSource(`
    class Renderer { hook() {} }
    const renderer = new Renderer();
    renderer.hook = function(value) { return value.amount };
    const storage = new Map();
    const key = {};
    storage.set(key, renderer);
    const stored = storage.get(key);
    console.log(stored === renderer);
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types[0] && checker.getPropertyOfType(types[0], 'amount'))
})

test('reading a callback owner from a local map does not hide an unknown consumer', () => {
  const { types } = inferSource(`
    class Renderer { hook() {} }
    const renderer = new Renderer();
    renderer.hook = function(value) { return value.amount };
    const storage = new WeakMap();
    const key = {};
    storage.set(key, renderer);
    unknownConsumer(storage.get(key));
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a reused local cell assignment target does not itself publish its callback owner', () => {
  const { checker, types } = inferSource(`
    class Renderer { hook() {} }
    let renderer;
    const created = new Renderer();
    renderer = created;
    renderer.hook = function(value) { return value.amount };
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types[0] && checker.getPropertyOfType(types[0], 'amount'))
})

test('assignment expression results retain their receiver escape path', () => {
  for (const publication of ['external(alias = renderer)', 'external(bag.owner = renderer)']) {
    const { types } = inferSource(`
      class Renderer { hook() {} }
      const renderer = new Renderer();
      renderer.hook = function(value) { return value.amount };
      let alias;
      const bag = { owner: renderer };
      ${publication};
      renderer.hook({ amount: 3 });
    `)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      publication
    )
  }
})

test('ordinary arguments do not implicitly contain a sibling method receiver', () => {
  const { checker, types } = inferSource(`
    class Renderer { hook() {} copy() { console.log(arguments.length) } }
    const renderer = new Renderer();
    renderer.hook = function(value) { return value.amount };
    renderer.copy(3);
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types[0] && checker.getPropertyOfType(types[0], 'amount'))
})

test('an inherited constructor value cannot hide uncounted callback instances', () => {
  for (const extra of [
    'globalThis.unknownConsumer(object.constructor);',
    'const alias = object; globalThis.unknownConsumer(alias.constructor);'
  ]) {
    const { types } = infer(extra)
    assert.ok(
      types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0),
      extra
    )
  }
  const { types } = inferSource(`
    class Owner { constructor() { this.hook = function(value) { return value.x } } }
    const object = new Owner();
    globalThis.unknownConsumer(new Owner().constructor);
    object.hook({x: 1});
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('a receiver passed as an ordinary argument still needs the arguments-object escape proof', () => {
  const { types } = inferSource(`
    class Renderer { hook() {} copy() { external(arguments[0]) } }
    const renderer = new Renderer();
    renderer.hook = function(value) { return value.amount };
    renderer.copy(renderer);
    renderer.hook({ amount: 3 });
  `)
  assert.ok(types.every((type) => type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0))
})

test('constructor argument forwarding retains the complete callback-owner use boundary', () => {
  for (const [body, closed] of [
    ['owner === null;', true],
    ['globalThis.unknownConsumer(owner);', false],
    ['globalThis.unknownConsumer(arguments[0]);', false]
  ] as const) {
    const { checker, types } = inferSource(`
      class Owner { hook() {} }
      class Holder { constructor(owner) { ${body} } }
      const object = new Owner();
      object.hook = function(value) { return value.amount };
      new Holder(object);
      object.hook({amount: 1});
    `)
    const type = types[0]
    assert.equal(Boolean(type && checker.getPropertyOfType(type, 'amount')), closed, body)
  }
})
