import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusObjectBagBindings } from './object-bag-bindings.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { emptyParameterBindingCensus } from './parameter-bindings.js'

const audit = (source: string) => {
  const entry = resolve('test/fixtures/populated-record-late-fields.js')
  const options: ts.CompilerOptions = { allowJs: true, checkJs: true, strict: true, target: ts.ScriptTarget.ES2022, noEmit: true }
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS)
      : getSourceFile(name, version, onError, fresh)
  const program = ts.createProgram({ rootNames: [entry], options, host })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const bags = censusObjectBagBindings(checker, [file], wholeProgram, emptyParameterBindingCensus, flow)
  const declarations = new Map<string, ts.Node>()
  const walk = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name))
      declarations.set(node.name.text, node)
    ts.forEachChild(node, walk)
  }
  walk(file)
  const accessNamed = (key: string): ts.PropertyAccessExpression | null => {
    let found: ts.PropertyAccessExpression | null = null
    const find = (node: ts.Node): void => {
      if (found === null && ts.isPropertyAccessExpression(node) && node.name.text === key) found = node
      ts.forEachChild(node, find)
    }
    find(file)
    return found
  }
  return {
    checker,
    bags,
    accessNamed,
    shape: (name: string) => bags.shapeForOwner(declarations.get(name)!),
    type: (name: string) => checker.getTypeAtLocation(declarations.get(name)!)
  }
}

test('populated records retain allocation fields and infer later named writes through aliases', () => {
  const { checker, shape } = audit(`
    const record = { count: 4, label: 'seed' };
    const alias = record;
    alias.enabled = true;
    alias['ready'] = false;
    console.log(record.count, record.enabled, alias.ready);
  `)
  const record = shape('record')
  assert.ok(record)
  assert.deepEqual([...record.members.keys()], ['count', 'label', 'enabled', 'ready'])
  assert.deepEqual([...record.required!], ['count', 'label'])
  assert.equal(checker.typeToString(checker.getBaseTypeOfLiteralType(record.members.get('enabled')!)), 'boolean')
  assert.equal(record.index, null)
  assert.deepEqual([...shape('alias')!.members], [...record.members])
})

test('an initial field joins later writes and deletion retains its absence', () => {
  const { checker, shape } = audit(`
    const record = { count: 4 };
    record.count = 'later';
    record.enabled = true;
    delete record['count'];
    console.log(record.count);
  `)
  const record = shape('record')
  assert.ok(record)
  assert.equal(record.required!.has('count'), false)
  const count = record.members.get('count')!
  assert.ok(count.isUnion(), checker.typeToString(count))
  assert.ok(count.types.some((type) => (type.flags & ts.TypeFlags.NumberLike) !== 0))
  assert.ok(count.types.some((type) => (type.flags & ts.TypeFlags.StringLike) !== 0))
})

test('populated record augmentation does not claim unchanged, explicitly stated, or reassigned storage', () => {
  const { shape } = audit(`
    const unchanged = { count: 4 };
    unchanged.count = 6;
    /** @type {{ count: number }} */
    const stated = { count: 4 };
    stated.enabled = true;
    let replaced = { count: 4 };
    replaced.enabled = true;
    replaced = external();
    console.log(unchanged, stated, replaced);
  `)
  assert.equal(shape('unchanged'), null)
  assert.equal(shape('stated'), null)
  assert.equal(shape('replaced'), null)
})

test('late-field inference preserves populated identity through a factory return and a parameter', () => {
  const { shape } = audit(`
    function fill(record) { record.enabled = true; }
    function make() {
      const record = { count: 4 };
      fill(record);
      return record;
    }
    const result = make();
    console.log(result.count, result.enabled);
  `)
  const result = shape('result')
  assert.ok(result)
  assert.deepEqual([...result.members.keys()], ['count', 'enabled'])
  assert.deepEqual([...result.required!], ['count'])
})

test('a stated parameter keeps its declared view while writes still reach the underlying record', () => {
  const { shape } = audit(`
    /** @param {{ count: number }} values */
    function fill(values) { values.enabled = true; }
    const record = { count: 4 };
    fill(record);
    console.log(record.enabled);
  `)
  assert.equal(shape('values'), null)
  const record = shape('record')
  assert.ok(record)
  assert.deepEqual([...record.members.keys()], ['count', 'enabled'])
})

test('reading a populated record through runtime keys does not invent an index or unwritten fields', () => {
  const { shape } = audit(`
    const record = { count: 4 };
    record.enabled = true;
    for (const key in record) console.log(record[key]);
    console.log(record.missing);
  `)
  const record = shape('record')
  assert.ok(record)
  assert.equal(record.index, null)
  assert.equal(record.members.has('missing'), false)
})

test('a returned API member forwards the populated record identity into its implementation', () => {
  const { shape } = audit(`
    function createTools() {
      function inspect(values) { console.log(values.count, values.enabled); }
      return { inspect: inspect };
    }
    const tools = createTools();
    const record = { count: 4 };
    record.enabled = true;
    tools.inspect(record);
  `)
  const record = shape('record')
  assert.ok(record)
  assert.deepEqual([...shape('values')!.members], [...record.members])
})

test('type queries keep the augmented allocation shape without changing an unrelated stated view', () => {
  const { bags, shape, type } = audit(`
    function makeRecord() {
      const record = { count: 4 };
      record.enabled = true;
      return record;
    }
    /** @param {ReturnType<typeof makeRecord>} values */
    function inspect(values) { console.log(values.count, values.enabled); }
    /** @param {{ count: number }} narrow */
    function inspectNarrow(narrow) { console.log(narrow.count); }
    inspect(makeRecord());
    inspectNarrow(makeRecord());
  `)
  const record = shape('record')
  assert.ok(record)
  assert.deepEqual([...bags.shapeForType(type('values'))!.members], [...record.members])
  assert.deepEqual([...shape('values')!.members], [...record.members])
  assert.equal(bags.shapeForType(type('narrow')), null)
})

/**
 * three's `InterleavedBuffer.clone( data )` shape: a `@param {Object}`
 * parameter filled with `data.arrayBuffers = {}` and then keyed into.
 *
 * `{Object}` resolves to the REAL `lib.es5` `Object` interface, which passes
 * every vacuity test and declares no `arrayBuffers`, so the checker has no
 * symbol for the member and this census had no identity to key the bag on.
 * That one slot is the receiver of the keyed write blocking both the
 * class-family absence proof and the WebGL context's numeric-absence proof,
 * and it is the three.js app's only `typedPropertyBoxes` row.
 */
const interleaved = (tail = ''): string => `export {};
  /** @param {Object} [data] */
  function clone( data ) {
    if ( data.arrayBuffers === undefined ) { data.arrayBuffers = {}; }
    if ( data.arrayBuffers[ 'k' ] === undefined ) { data.arrayBuffers[ 'k' ] = 1; }
    return data.arrayBuffers[ 'k' ];
  }
  clone( {} );
  ${tail}`

test('a bag roots at an expando member write whose receiver type does not declare the key', () => {
  const { bags, accessNamed } = audit(interleaved())
  assert.notEqual(bags.shapeAt(accessNamed('arrayBuffers')!), null)
})

/**
 * The guard that keeps the synthetic identity from splitting one object into
 * two bags. If ANY access spelling the name resolves to a real declared
 * member, the name is not expando at all: that occurrence would take the
 * ordinary declaration identity while these took the synthetic one, and an
 * object reached through both spellings would be two bags, each looking
 * closed while the other wrote keys into it -- a silently SMALLER member set,
 * which is a wrong answer rather than a refusal.
 */
test('a name that is declared anywhere in the program roots no expando bag', () => {
  const { bags, accessNamed } = audit(interleaved('class Holder { constructor() { this.arrayBuffers = {}; } }\n  new Holder();'))
  assert.equal(bags.shapeAt(accessNamed('arrayBuffers')!), null)
})

test('a class field allocation shares typed index storage through helper parameters', () => {
  const { checker, shape } = audit(`
    class Holder { cache = {}; }
    function write(target, index) { target[index] = 1; }
    function forward(values) { write(values, 0); }
    const holder = new Holder();
    forward(holder.cache);
  `)
  const cache = shape('cache')
  assert.ok(cache)
  assert.ok(cache.index)
  assert.equal(checker.typeToString(checker.getBaseTypeOfLiteralType(cache.index)), 'number')
  assert.deepEqual(shape('values'), cache)
  assert.deepEqual(shape('target'), cache)
})

test('class field replacement cannot borrow its initializer bag shape', () => {
  for (const replacement of ['holder.cache = external()', 'const alias = holder; alias.cache = external()']) {
    const { shape } = audit(`
      class Holder { cache = {}; }
      const holder = new Holder();
      ${replacement};
      function write(values, index) { values[index] = 1; }
      write(holder.cache, 0);
    `)
    assert.equal(shape('cache'), null, replacement)
    assert.equal(shape('values'), null, replacement)
  }
})

test('an empty allocation does not replace a parameter written view', () => {
  const { shape } = audit(`
    /** @param {{ count?: number }} values */
    function fill(values) { values.count = 4; }
    const record = {};
    fill(record);
  `)
  assert.ok(shape('record'))
  assert.ok(shape('values') === null, 'a written parameter view must not be replaced by its allocation bag')
})

test('a literal-key read shares native indexed bag storage rather than creating a dynamic fixed slot', () => {
  const { checker, shape, bags, accessNamed } = audit(`
    const cache = {};
    function write(cache, index) { cache[index] = 1; }
    write(cache, 0);
    console.log(cache[0], cache.label);
  `)
  const cache = shape('cache')
  assert.ok(cache?.index)
  assert.deepEqual([...cache.members.keys()], [])
  assert.equal(checker.typeToString(checker.getBaseTypeOfLiteralType(cache.index)), 'number')
  const access = accessNamed('label')!
  const read = bags.slotTypeAt(access)
  assert.ok(read)
  assert.ok(read.isUnion() && read.types.some((type) => (type.flags & ts.TypeFlags.Undefined) !== 0))
})
