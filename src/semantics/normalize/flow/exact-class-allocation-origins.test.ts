import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { exactClassAllocationOriginsOf, type ClassAllocationAuthority } from './member-call-forwarding.js'
import { closedClassAllocationOriginsOf } from './callable-reach.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/exact-class-allocation-origins.ts')
  const host = ts.createCompilerHost({ target: ts.ScriptTarget.ES2022, types: [] })
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ES2022, types: [] }, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const call = flow.calls.find((site) => site.call.expression.getText() === 'probe')?.call
  assert.ok(call?.arguments?.[0])
  return { checker, flow, expression: call.arguments[0] }
}

const authorityWith = (overrides: Partial<ClassAllocationAuthority>): ClassAllocationAuthority => ({
  parameterValuesOf: () => null,
  thisFamilyOf: () => null,
  fieldValuesOf: () => null,
  bindingValuesOf: () => null,
  callCompletionValuesOf: () => null,
  whenSettled: (publish) => publish(),
  ...overrides
})

const classesOf = (source: string) => {
  const { checker, flow, expression } = inspect(source)
  const answer = closedClassAllocationOriginsOf(checker, flow, expression)
  return answer ? [...answer.classes].map((owner) => owner.name?.text).sort() : null
}

const fieldClassesOf = (source: string) => {
  const { checker, flow, expression } = inspect(source)
  const answer = closedClassAllocationOriginsOf(checker, flow, expression)
  return answer ? [...answer.classes].map((owner) => owner.name?.text).sort() : null
}

const capturedFieldClassesOf = (source: string) => {
  const { checker, flow, expression } = inspect(source)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const query = () => closedClassAllocationOriginsOf(checker, flow, expression)
  const first = ledger.capture(query)
  assert.ok(first.value)
  assert.ok(first.requirements.some((requirement) => requirement.intrinsic === 'Array'))
  const replay = ledger.capture(query)
  assert.deepEqual(replay.value, first.value)
  assert.deepEqual(replay.requirements, first.requirements)
  return [...first.value.classes].map((owner) => owner.name?.text).sort()
}

test('class allocation cycles close only on their own allocation origins', () => {
  assert.deepEqual(classesOf('class Item {} let held = new Item(); let alias = held; held = alias; probe(held);'), ['Item'])
  assert.deepEqual(classesOf('class Item {} let held: Item | null = null; held = new Item(); probe(held);'), ['Item'])
  assert.equal(classesOf('class Item {} var held = held; probe(Math.random() ? new Item() : held);'), null)
  assert.equal(classesOf('class Item {} declare const external: unknown; probe(Math.random() ? new Item() : external as Item);'), null)
})

test('recursive factory completions share the same grounded component independent of declaration order', () => {
  const factories = ['function first() { return Math.random() ? new Item() : second() }', 'function second() { return first() }']
  for (const ordered of [factories, [...factories].reverse()]) {
    assert.deepEqual(classesOf(`class Item {} ${ordered.join('\n')} probe(first());`), ['Item'])
  }
  assert.equal(
    classesOf(
      'class Item {} function first() { return second() } function second() { return first() } probe(Math.random() ? new Item() : first());'
    ),
    null
  )
})

test('allocation proofs do not reuse a different receiver authority answer', () => {
  for (const reverse of [false, true]) {
    const { checker, flow, expression } = inspect('class Item { read() { probe(this) } } new Item().read();')
    const classes = new Set(flow.classDeclarations)
    const constructions = new Map(
      flow.calls
        .map((site) => site.call)
        .filter(ts.isNewExpression)
        .map((call) => [call, [...classes]])
    )
    const closed = () => ({ classes, constructions })
    const opaque = () => null
    for (const authority of reverse ? [opaque, closed] : [closed, opaque]) {
      const result = exactClassAllocationOriginsOf(checker, flow, expression, authorityWith({ thisFamilyOf: authority }))
      assert.equal(result !== null, authority === closed)
    }
  }
})

test('a supplied invocation authority owns completion admission, including refusal and cache identity', () => {
  for (const reverse of [false, true]) {
    const { checker, flow, expression } = inspect('class Item {} function make() { return new Item() } probe(make());')
    const construction = flow.calls.map((site) => site.call).find(ts.isNewExpression)!
    const closed = () => [construction]
    const refused = () => null
    assert.equal(exactClassAllocationOriginsOf(checker, flow, expression, authorityWith({})), null, 'no legacy completion resolver exists')
    for (const authority of reverse ? [refused, closed] : [closed, refused]) {
      const result = exactClassAllocationOriginsOf(checker, flow, expression, authorityWith({ callCompletionValuesOf: authority }))
      assert.equal(result !== null, authority === closed, 'a consumer cannot replace an authoritative refusal with its own syntax decision')
    }
  }
})

test('cached invocation completions retain their authority obligations', () => {
  const { checker, flow, expression } = inspect('class Item {} function make() { return new Item() } probe(make());')
  const construction = flow.calls.map((site) => site.call).find(ts.isNewExpression)!
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const completions = (call: ts.CallExpression) => {
    assert.equal(ledger.require('Object', call), true)
    return [construction]
  }
  const authority = authorityWith({ callCompletionValuesOf: completions })
  const query = () => exactClassAllocationOriginsOf(checker, flow, expression, authority)
  const first = ledger.capture(query)
  assert.ok(first.value)
  assert.equal(first.requirements.length, 1)
  const cached = ledger.capture(query)
  assert.deepEqual(cached.value, first.value)
  assert.deepEqual(cached.requirements, first.requirements)
  assert.equal(query(), null, 'a cached answer is not permission to discard the obligations that justify it')
})

test('explicit invocation completions retain thisArg independently of ordinary arguments', () => {
  for (const invocation of ['identity.call(new B(), new A())', 'identity.apply(new B(), [new A()])']) {
    const { checker, flow, expression } = inspect(`
      class A {}
      class B {}
      function identity(this: object, value: A) { return this; }
      probe(${invocation});
    `)
    const ledger = createDeferredIntrinsicProtocolLedger()
    attachDeferredIntrinsicProtocolLedger(flow, ledger)
    const query = () => closedClassAllocationOriginsOf(checker, flow, expression)
    const first = ledger.capture(query)
    assert.deepEqual(first.value && [...first.value.classes].map((owner) => owner.name?.text), ['B'], invocation)
    assert.ok(first.requirements.some((requirement) => requirement.intrinsic === 'Function'))
    const cached = ledger.capture(query)
    assert.deepEqual(cached.value, first.value)
    assert.deepEqual(cached.requirements, first.requirements)
  }
})

test('cached field origins replay the obligations of their authenticated field authority', () => {
  const { checker, flow, expression } = inspect('class Item {} const holder = {field: new Item()}; probe(holder.field);')
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const construction = flow.calls.map((site) => site.call).find(ts.isNewExpression)!
  const fields = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression) => {
    assert.equal(ledger.require('Object', access), true)
    return [construction]
  }
  const authority = authorityWith({ fieldValuesOf: fields })
  const query = () => exactClassAllocationOriginsOf(checker, flow, expression, authority)
  const first = ledger.capture(query)
  assert.ok(first.value)
  assert.equal(first.requirements.length, 1)
  const cached = ledger.capture(query)
  assert.deepEqual(cached.value, first.value)
  assert.deepEqual(cached.requirements, first.requirements)
  assert.equal(query(), null, 'a cache hit cannot discard its proof obligations outside a capture')
  assert.equal(
    ledger.capture(() => exactClassAllocationOriginsOf(checker, flow, expression, authorityWith({}))).value,
    null,
    'a different field authority cannot inherit the closed answer'
  )
})

test('field origins follow constructor initializers and parameter properties', () => {
  assert.deepEqual(
    fieldClassesOf(`
      class Item {}
      class Holder {
        field = new Item()
        read() { probe(this.field) }
      }
      new Holder().read()
    `),
    ['Item']
  )
  assert.deepEqual(
    fieldClassesOf(`
      class Item {}
      class Holder {
        constructor(public field: Item) {}
        read() { probe(this.field) }
      }
      new Holder(new Item()).read()
    `),
    ['Item']
  )
})

test('field origins join complete source reassignments', () => {
  assert.deepEqual(
    fieldClassesOf(`
      class First {}
      class Second {}
      class Holder {
        field = new First()
        replace() { this.field = new Second() }
        read() { probe(this.field) }
      }
      const holder = new Holder()
      holder.replace()
      holder.read()
    `),
    ['First', 'Second']
  )
})

test('field origins refuse opaque and descriptor overwrites', () => {
  assert.equal(
    fieldClassesOf(`
      class Item {}
      class Holder {
        field = new Item()
        read() { probe(this.field) }
      }
      declare const external: Item
      const holder = new Holder()
      holder.field = external
      holder.read()
    `),
    null
  )
  assert.equal(
    fieldClassesOf(`
      class Item {}
      class Holder {
        field = new Item()
        read() { probe(this.field) }
      }
      declare const external: Item
      const holder = new Holder()
      Object.defineProperty(holder, 'field', { value: external })
      holder.read()
    `),
    null
  )
})

test('field origins refuse a receiver borrowed from outside the closed program', () => {
  assert.equal(
    fieldClassesOf(`
      class Item {}
      class Holder { field = new Item() }
      declare const borrowed: Holder
      probe(borrowed.field)
    `),
    null
  )
})

test('field origins retain parameter-property stores and inherited initialization', () => {
  assert.deepEqual(
    fieldClassesOf(`
    class First {} class Second {}
    class Holder { constructor(public field: First | Second) { this.field = new Second() } }
    const holder = new Holder(new First()); probe(holder.field);
  `),
    ['First', 'Second']
  )
  assert.deepEqual(
    fieldClassesOf(`
    class Item {}
    class Base { field = new Item() }
    class Child extends Base {}
    const holder = new Child(); probe(holder.field);
  `),
    ['Item']
  )
})

test('field closure rejects opaque publications, indirect mutation and descriptor changes', () => {
  for (const operation of [
    'external(holder)',
    'external(holder.self)',
    'declare const key: string; holder[key] = replacement',
    'Object.assign(holder, { field: replacement })',
    'Reflect.set(holder, "field", replacement)',
    'delete holder.field',
    'Object.setPrototypeOf(holder, replacement)',
    'const alias: any = holder; alias.field = replacement'
  ]) {
    assert.equal(
      fieldClassesOf(`
      class Item {}
      class Holder { field = new Item(); self = this }
      declare const replacement: unknown;
      declare function external(value: unknown): void;
      const holder = new Holder(); ${operation}; probe(holder.field);
    `),
      null,
      operation
    )
  }
  assert.equal(
    fieldClassesOf(`
    class Item {} class Holder { field = new Item() }
    class Child extends Holder { get field() { return external() } }
    declare function external(): Item;
    const holder = new Child(); probe(holder.field);
  `),
    null
  )
  assert.equal(
    fieldClassesOf(`
    class Item {} class Holder { field = new Item(); read() { probe(this.field) } }
    declare const borrowed: Holder;
    Holder.prototype.read.call(borrowed);
  `),
    null
  )
})

test('field origins follow closed array elements through spread and non-null reads', () => {
  for (const source of [
    'const values = [new Item()]; probe(values[0]!);',
    'const seed = [new Item()]; const values = [...seed]; probe(values[0]!);'
  ]) {
    assert.deepEqual(capturedFieldClassesOf(`class Item {} ${source}`), ['Item'], source)
  }
})

test('field origins join closed array-element replacements', () => {
  assert.deepEqual(
    capturedFieldClassesOf(`
      class First {} class Second {}
      const values = [new First()]
      values[0] = new Second()
      probe(values[0]!)
    `),
    ['First', 'Second']
  )
})

test('array-element origins refuse an opaque array escape', () => {
  assert.equal(
    fieldClassesOf(`
    class Item {}
    const values = [new Item()]
    declare function external(value: unknown): void
    external(values)
    probe(values[0]!)
  `),
    null
  )
})

test('iteration bindings use closed array contents for exact class origins and replay their obligations', () => {
  assert.deepEqual(
    capturedFieldClassesOf(
      'class First {} class Second {} const items = [new First(), new Second()]; for (const item of items) { probe(item); }'
    ),
    ['First', 'Second']
  )
  assert.deepEqual(
    capturedFieldClassesOf('class Item {} const items = [new Item()]; let item = new Item(); for (item of items) { probe(item); }'),
    ['Item']
  )
})

test('iteration origins refuse opaque storage, replacement, key enumeration and asynchronous iteration', () => {
  for (const source of [
    'class Item {} declare function opaque(x: unknown): void; const items = [new Item()]; opaque(items); for (const item of items) { probe(item); }',
    'class Item {} declare const unknownItem: unknown; const items = [new Item()]; for (let item of items) { item = unknownItem as Item; probe(item); }',
    'class Item {} const items = [new Item()]; for (const item in items) { probe(item); }',
    'class Item {} async function read() { const items = [new Item()]; for await (const item of items) { probe(item); } } read();',
    'class Item {} const items = [new Item()]; items[Symbol.iterator] = function* () { yield new Item() }; for (const item of items) { probe(item); }'
  ])
    assert.equal(fieldClassesOf(source), null, source)
})

test('iteration origin proof observes replacement of the intrinsic iterator', () => {
  assert.equal(
    fieldClassesOf(
      'class Item {} Array.prototype[Symbol.iterator] = function* () { yield new Item() }; const items = [new Item()]; for (const item of items) { probe(item); }'
    ),
    null
  )
})

test('iteration field contents retain the shared computed-key frame authority', () => {
  const source = `
    class Item {}
    class Holder {
      items = [new Item()];
      assign() { const values = { label: 1 }; for (const key in values) this[key] = values[key]; }
    }
    const holder = new Holder();
    holder.assign();
    for (const item of holder.items) { probe(item); }
  `
  assert.deepEqual(capturedFieldClassesOf(source), ['Item'])
  for (const options of ['{ items: [] }', 'externalOptions']) {
    const { checker, flow, expression } = inspect('declare const externalOptions: unknown;\n' + source.replace('{ label: 1 }', options))
    const ledger = createDeferredIntrinsicProtocolLedger()
    attachDeferredIntrinsicProtocolLedger(flow, ledger)
    assert.equal(ledger.capture(() => closedClassAllocationOriginsOf(checker, flow, expression)).value, null, options)
  }
})

test('computed stores to absent class keys retain the prototype obligation and close the caller frame', () => {
  const { checker, flow, expression } = inspect(`
    class Item {}
    class Holder {
      items = [new Item()];
      assign(values) { for (const key in values) this[key] = values[key]; }
    }
    const holder = new Holder();
    holder.assign({ label: 1 });
    for (const item of holder.items) { probe(item); }
  `)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const result = ledger.capture(() => closedClassAllocationOriginsOf(checker, flow, expression))
  assert.deepEqual(result.value && [...result.value.classes].map((owner) => owner.name?.text), ['Item'])
  assert.ok(
    result.requirements.some((requirement) => requirement.intrinsic === 'Object' && requirement.prototypeKeys?.names?.includes('label'))
  )
})

test('computed data stores close their caller frame through the existing member proof', () => {
  const source = `
    class Item {}
    class Holder {
      label = 0;
      items = [new Item()];
      assign(values) { for (const key in values) this[key] = values[key]; }
    }
    const holder = new Holder();
    holder.assign({ label: 1 });
    for (const item of holder.items) { probe(item); }
  `
  assert.deepEqual(capturedFieldClassesOf(source), ['Item'])
  assert.deepEqual(
    capturedFieldClassesOf(
      source.replace('this[key] = values[key];', '{ const current = this[key]; if (current !== undefined) this[key] = values[key]; }')
    ),
    ['Item']
  )
  for (const variant of [
    source.replace('{ label: 1 }', '{ items: [] }'),
    source.replace('{ label: 1 }', 'externalOptions'),
    source.replace('{ label: 1 }', '{ assign: externalCallable }'),
    source.replace('label = 0;', 'set label(value) { externalCallable(this); }'),
    source.replace('holder.assign({ label: 1 });', 'externalCallable(holder); holder.assign({ label: 1 });'),
    source
      .replace('label = 0;', '')
      .replace('holder.assign({ label: 1 });', 'holder.assign({ label: holder }); externalCallable(holder["label"]);'),
    source.replace(
      'holder.assign({ label: 1 });',
      'Object.defineProperty(holder, "label", {set(value) {externalCallable(this);}}); holder.assign({ label: 1 });'
    )
  ]) {
    const { checker, flow, expression } = inspect(
      `declare const externalOptions: unknown; declare function externalCallable(value?: unknown): void;\n${variant}`
    )
    const ledger = createDeferredIntrinsicProtocolLedger()
    attachDeferredIntrinsicProtocolLedger(flow, ledger)
    assert.equal(ledger.capture(() => closedClassAllocationOriginsOf(checker, flow, expression)).value, null, variant)
  }
})

test('a constructor function parameter reaches an allocation stored and returned through a class field', () => {
  assert.deepEqual(
    classesOf(`
      class Ctx {
        method(a: number, b: number) { return a + b }
      }
      class Canvas {
        private context: Ctx | null = null
        setContext(ctx: Ctx) { this.context = ctx }
        getContext(kind: string): Ctx | null { if (kind === 'webgl2') return this.context; return null }
      }
      const canvas = new Canvas()
      canvas.setContext(new Ctx())
      function Uniforms(gl) {
        this.setValue = function (v) { probe(gl) }
      }
      const gl = canvas.getContext('webgl2')
      new Uniforms(gl)
    `),
    ['Ctx']
  )
})

test('allocation origins follow a class allocated once and read through a module-pattern host factory', () => {
  // The shape `WebGLAttributes`/`WebGLExtensions`/`WebGLState` use: a plain
  // function that captures its `gl` parameter in nested closures and RETURNS
  // an object literal of them, rather than writing `this.<key> = ...`
  // (`isConstructorFunction` is false for it). `gl` is a bare captured
  // identifier here, so this exercises the parameter-value walk, not
  // destructuring -- see the binding-element tests below for the shape that
  // was actually broken.
  assert.deepEqual(
    classesOf(`
      class Ctx {
        method(a: number, b: number) { return a + b }
      }
      class Canvas {
        private context: Ctx | null = null
        setContext(ctx: Ctx) { this.context = ctx }
        getContext(kind: string): Ctx | null { if (kind === 'webgl2') return this.context; return null }
      }
      const canvas = new Canvas()
      canvas.setContext(new Ctx())
      function Attributes(gl) {
        function get() { probe(gl) }
        return { get: get }
      }
      const gl = canvas.getContext('webgl2')
      const attrs = new Attributes(gl)
      attrs.get()
    `),
    ['Ctx']
  )
})

test('allocation origins follow a let binding reassigned through a nested helper inside a conditional try', () => {
  // Mirrors `WebGLRenderer`'s own `let _gl = context; ... if (_gl === null) {
  // _gl = getContext(...) }`, read later by a DIFFERENT closure
  // (`initGLContext`) than the one that assigned it.
  assert.deepEqual(
    classesOf(`
      class Ctx {
        method(a: number, b: number) { return a + b }
      }
      class Canvas {
        private context: Ctx | null = null
        setContext(ctx: Ctx) { this.context = ctx }
        getContext(kind: string): Ctx | null { if (kind === 'webgl2') return this.context; return null }
      }
      function Attributes(gl) { probe(gl) }
      function makeRenderer(canvas: Canvas, context: Ctx | null) {
        let _gl = context
        function getContext(name: string) { return canvas.getContext(name) }
        try {
          if (_gl === null) {
            _gl = getContext('webgl2')
            if (_gl === null) throw new Error('x')
          }
        } catch (e) { throw e }
        function init() {
          new Attributes(_gl)
        }
        init()
      }
      const canvas = new Canvas()
      canvas.setContext(new Ctx())
      makeRenderer(canvas, null)
    `),
    ['Ctx']
  )
})

test('a destructured binding element with a default resolves through an object literal that always states the key', () => {
  // `source-value-session.ts`'s 'binding-element' query used to refuse EVERY
  // defaulted destructuring element unconditionally (`fail('defaulted-binding
  // -element', ...)`), regardless of whether the default could ever fire.
  // three's `WebGLRenderer` destructures its whole options bag this way --
  // `const { canvas = createCanvasElement(), context = null, ... } =
  // parameters` -- and every call site states every field as a literal
  // property (`new WebGLRenderer({ canvas, context, depth: true, ... })`), so
  // the default is dead code there. Refusing it anyway made `_gl`, and every
  // WebGL host call reached through it, permanently unenumerable no matter
  // what the program wrote -- the `family:allocations-not-enumerable` leaves
  // ranked at WebGLAttributes.js, WebGLExtensions.js, WebGLUniforms.js and
  // WebGLState.js in the leaf-refusal log.
  for (const withDefault of ['{ context = null }', '{ context = opaqueDefault() }']) {
    assert.deepEqual(
      classesOf(`
        class Ctx {
          method(a: number, b: number) { return a + b }
        }
        declare function opaqueDefault(): Ctx
        function Renderer(parameters: { context?: Ctx | null }) {
          const ${withDefault} = parameters
          probe(context)
        }
        const ctx = new Ctx()
        Renderer({ context: ctx })
      `),
      ['Ctx'],
      withDefault
    )
  }
})

test('a destructured default stays refused when the call site can actually omit the field', () => {
  // Soundness check for the fix above: when a reachable call site's literal
  // does NOT state the key, the default really can fire, and an opaque
  // default must still refuse -- `ownEntries` returning null for that root is
  // what keeps this case closed.
  assert.equal(
    classesOf(`
      class Ctx {
        method(a: number, b: number) { return a + b }
      }
      declare function opaqueDefault(): Ctx
      function Renderer(parameters: { context?: Ctx | null }) {
        const { context = opaqueDefault() } = parameters
        probe(context)
      }
      const ctx = new Ctx()
      Renderer({ context: ctx })
      Renderer({})
    `),
    null
  )
})

test('a destructured default stays refused behind a spread the literal walk cannot enumerate', () => {
  assert.equal(
    classesOf(`
      class Ctx {
        method(a: number, b: number) { return a + b }
      }
      declare function opaqueDefault(): Ctx
      function Renderer(parameters: { context?: Ctx | null }) {
        const { context = opaqueDefault() } = parameters
        probe(context)
      }
      const ctx = new Ctx()
      declare const rest: { context?: Ctx | null }
      Renderer({ ...rest, context: ctx })
    `),
    null
  )
})

test('computed member closure retains data and absent arms across a class family', () => {
  assert.deepEqual(
    capturedFieldClassesOf(`
    class Item {}
    class Base {
      items = [new Item()];
      assign(values) {
        for (const key in values) {
          const current = this[key];
          if (current !== undefined) this[key] = values[key];
        }
      }
    }
    class WithLabel extends Base { label = 0; }
    const first = new WithLabel();
    const second = new Base();
    first.assign({ label: 1 });
    second.assign({ spare: 1 });
    for (const item of first.items) { probe(item); }
  `),
    ['Item']
  )
})
