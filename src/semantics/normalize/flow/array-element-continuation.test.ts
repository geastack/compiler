import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { closedCallableAuthorityOf, hasClosedValueUses } from './callable-reach.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { arrayStoredValuesOf } from './array-element-continuation.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import type { NativeCollectionProtocolPlan } from './native-collection-protocol.js'
import type { ComputedKeySetAuthority } from './computed-key-set.js'
import type { ValueFlowIndex } from './model.js'
import type { OriginAuthority } from './origin-authority.js'

/** Deferred mode is production's: the intrinsic protocols become ledger
 * requirements discharged by the sealed census. Closed mode proves them
 * in place, which is where prototype overrides and `globalThis` escapes are
 * observable at this layer. */
const setup = (source: string, deferred: boolean, js = false) => {
  const entry = resolve(`test/fixtures/array-element-continuation.${js ? 'js' : 'ts'}`)
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: js }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? ts.createSourceFile(name, 'export {};\n' + source, version, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = deferred ? createDeferredIntrinsicProtocolLedger() : null
  if (ledger) attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const args = censusArgumentsObjects(checker, [file])
  const closed = (plan: NativeCollectionProtocolPlan): boolean =>
    plan.deferred
      ? ledger?.require(plan.intrinsic, plan.location) === true
      : hasClosedValueUses(
          checker,
          flow,
          plan.roots,
          plan.terminalUse,
          (node) => checker.getTypeAtLocation(node),
          (owner) => args.usesByOwner.get(owner)
        )
  return { file, checker, flow, ledger, closed }
}

/** The receiver of the LAST element access spelled on `receiver`. */
const receiverOf = (file: ts.SourceFile, receiver: string): ts.Expression => {
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && node.expression.getText(file) === receiver) found = node.expression
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, receiver)
  return found
}

const authorityOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  protocolClosed: (plan: NativeCollectionProtocolPlan) => boolean,
  numericKey: (key: ts.Expression) => boolean = () => false,
  intrinsicIntact?: ComputedKeySetAuthority['intrinsicIntact']
): OriginAuthority => {
  const base = closedCallableAuthorityOf(
    checker,
    flow,
    (expression) => checker.getTypeAtLocation(expression),
    () => undefined
  )
  return { ...base, protocolClosed, numericKey, ...(intrinsicIntact ? { intrinsicIntact } : {}) }
}

const stored = (
  source: string,
  {
    receiver = 'items',
    deferred = true,
    numeric = false,
    js = false,
    intrinsicIntact
  }: {
    receiver?: string
    deferred?: boolean
    numeric?: boolean
    js?: boolean
    /** States a fixture computed-key-set authority with this intrinsic check. */
    intrinsicIntact?: ComputedKeySetAuthority['intrinsicIntact']
  } = {}
): readonly string[] | null => {
  const { file, checker, flow, ledger, closed } = setup(source, deferred, js)
  const array = receiverOf(file, receiver)
  const authority = authorityOf(checker, flow, closed, numeric ? () => true : () => false, intrinsicIntact)
  const run = () =>
    arrayStoredValuesOf(checker, flow, array, authority)
      ?.map((node) => node.getText(file))
      .sort() ?? null
  if (!ledger) return run()
  const { value, requirements } = ledger.capture(run)
  if (value !== null) assert.ok(requirements.some((requirement) => requirement.intrinsic === 'Array'))
  return value
}

test('a local array enumerates literal elements, index stores and every storing method', () => {
  assert.deepEqual(
    stored(`const first = {}; const second = {}; const third = {}; const fourth = {}; const fifth = {}; const sixth = {};
      const items: object[] = [first];
      items.push(second); items[1] = third; items.unshift(fourth); items.splice(0, 1, fifth); items.fill(sixth);
      items.length = 0; items.pop(); items.shift(); items.at(0); items.indexOf(first); items.includes(first);
      items.reverse(); items.sort(); items.slice(1); for (const item of items) {} const count = items.length;
      if (items === undefined || !items) {} items[0];`),
    ['fifth', 'first', 'fourth', 'second', 'sixth', 'third']
  )
  assert.deepEqual(stored('const first = {}; const items = new Array<object>(3); items[0] = first; items[0];'), ['first'])
  assert.deepEqual(stored('const first = {}; const items = Array.of(first); items[0];'), ['first'])
  assert.deepEqual(
    stored('declare const choose: boolean; const first = {}; let items: object[] | null = null; items = choose ? [first] : []; items[0];'),
    ['first']
  )
})

test('aliases, copies and private fields share one stored-value family', () => {
  assert.deepEqual(
    stored('const first = {}; const second = {}; const items = [first]; const alias = items; alias.push(second); items[0];'),
    ['first', 'second']
  )
  assert.deepEqual(
    stored('const first = {}; const second = {}; const base = [first]; const items = base.slice(0).concat([second]); items[0];'),
    ['first', 'second']
  )
  assert.deepEqual(stored('const first = {}; const base = [first]; const items = Array.from(base); items[0];'), ['first'])
  assert.deepEqual(stored('const first = {}; const base = [first]; const items = [...base]; items[0];'), ['first'])
  assert.deepEqual(
    stored(
      'class Pool { #items: object[] = []; add(value: object) { this.#items.push(value) } read(index: number) { return this.#items[index] } }',
      {
        receiver: 'this.#items'
      }
    ),
    ['value']
  )
})

/** Three's `Texture.mipmaps`, reduced: filled through a method, copied by `copy`, read by an unrelated function. */
const TEXTURE = `class Texture {
    mipmaps: object[] = [];
    addMipmap(mipmap: object) { this.mipmaps.push(mipmap) }
    copy(source: Texture) { this.mipmaps = source.mipmaps.slice(0); return this }
  }
  class CompressedTexture extends Texture {}
  class Unrelated { mipmaps: number[] = [] }
  const first = {}; const second = {};
  const texture = new Texture(); texture.addMipmap(first);
  const other = new CompressedTexture().copy(texture); other.mipmaps.push(second);
  const unrelated = new Unrelated(); unrelated.mipmaps = [1]; unrelated.mipmaps.push(2);`
const READ = 'function read(t: Texture, level: number) { return t.mipmaps[level] }'

test('a public field of a closed class family is one cell across every instance', () => {
  assert.deepEqual(stored(`${TEXTURE} ${READ}`, { receiver: 't.mipmaps' }), ['mipmap', 'second'])
  assert.deepEqual(
    stored('const first = {}; class Holder { items = [first] } const holder = new Holder(); holder.items[0];', {
      receiver: 'holder.items'
    }),
    ['first']
  )
  // A receiver the checker cannot type is followed as a possible alias: its store widens the set.
  assert.deepEqual(
    stored(`${TEXTURE} const third = {}; declare const loose: any; loose.mipmaps.push(third); ${READ}`, { receiver: 't.mipmaps' }),
    ['mipmap', 'second', 'third']
  )
  // A union confined to the family still names its one cell.
  assert.deepEqual(
    stored(`${TEXTURE} declare const held: Texture | CompressedTexture | null; held!.mipmaps[0];`, { receiver: 'held!.mipmaps' }),
    ['mipmap', 'second']
  )
})

test('the protocol obligation of a field family is re-asked on every query', () => {
  const { file, checker, flow, ledger, closed } = setup(`${TEXTURE} ${READ}`, true)
  const array = receiverOf(file, 't.mipmaps')
  const authority = authorityOf(checker, flow, closed)
  for (let round = 0; round < 2; round += 1) {
    const { value, requirements } = ledger!.capture(() => arrayStoredValuesOf(checker, flow, array, authority))
    assert.deepEqual(value?.map((node) => node.getText(file)).sort(), ['mipmap', 'second'])
    assert.ok(
      requirements.some((requirement) => requirement.intrinsic === 'Array'),
      `round ${round}`
    )
  }
})

test('three spells the field in JavaScript: a constructor store, a JSDoc-typed copy and alias', () => {
  const source = (reader: string) => `class Texture {
      constructor() {
        /** @type {Array<Object>} */
        this.mipmaps = [];
      }
      /**
       * @param {Texture} source
       */
      copy( source ) { this.mipmaps = source.mipmaps.slice( 0 ); return this; }
    }
    class CompressedTexture extends Texture {
      constructor() { super(); this.isCompressedTexture = true; }
    }
    /**
     * @param {Texture} texture
     * @param {Object} mipmap
     */
    function addMipmap( texture, mipmap ) { texture.mipmaps.push( mipmap ); }
    ${reader}
    const texture = new Texture();
    addMipmap( texture, {} );
    new CompressedTexture().copy( texture );`
  const typed = `/**
     * @param {Texture} texture
     * @param {number} level
     */
    function read( texture, level ) { const mipmaps = texture.mipmaps; return mipmaps[ level ]; }`
  assert.deepEqual(stored(source(typed), { receiver: 'mipmaps', js: true }), ['mipmap'])
  // `WebGLTextures.uploadTexture`'s spelling: no authority types `texture`,
  // but its closed callers only ever pass a Texture, so the alias is the field.
  const untyped = 'function upload( texture, level ) { const local = texture.mipmaps; return local[ level ]; }'
  // (`level` is untyped too, so its index needs the caller's numeric authority.)
  const indexed = { receiver: 'mipmaps', js: true, numeric: true }
  assert.deepEqual(stored(source(`${typed} ${untyped} upload( new Texture(), 0 );`), indexed), ['mipmap'])
  // A caller outside the program may pass anything, and the whole family
  // that alias may belong to refuses with it.
  assert.equal(stored(source(`${typed} ${untyped} globalThis.external( upload );`), indexed), null)
  assert.equal(stored(source(`${typed} ${untyped} upload( globalThis.opaqueHook, 0 );`), indexed), null)
})

/** Three's `Texture.setValues`, in three's own JavaScript spelling. */
const SET_VALUES = (calls: string) => `class Texture {
      constructor() {
        /** @type {Array<Object>} */
        this.mipmaps = [];
        this.wrapS = 0;
        this.flipY = false;
      }
      /** @param {Object} mipmap */
      addMipmap( mipmap ) { this.mipmaps.push( mipmap ); }
      /** @param {Object} values */
      setValues( values ) {
        for ( const key in values ) {
          const newValue = values[ key ];
          this[ key ] = newValue;
        }
      }
    }
    /**
     * @param {Texture} texture
     * @param {number} level
     */
    function read( texture, level ) { const mipmaps = texture.mipmaps; return mipmaps[ level ]; }
    const texture = new Texture();
    texture.addMipmap( {} );
    ${calls}`

test('a keyed store whose proven key set omits the field leaves it alone, its intrinsic re-asked per query', () => {
  const intact = () => true
  const read = (calls: string, intrinsicIntact?: ComputedKeySetAuthority['intrinsicIntact']) =>
    stored(SET_VALUES(calls), { receiver: 'mipmaps', js: true, ...(intrinsicIntact ? { intrinsicIntact } : {}) })
  assert.deepEqual(read('texture.setValues( { wrapS: 1, flipY: true } );', intact), ['mipmap'])
  // The required authority can defer its prototype obligation to the ledger.
  assert.deepEqual(read('texture.setValues( { wrapS: 1 } );'), ['mipmap'])
  // A key set naming the field, or one no literal closes.
  assert.equal(read('texture.setValues( { mipmaps: [ {} ] } );', intact), null)
  assert.equal(read('texture.setValues( globalThis.options );', intact), null)
  // `for-in`'s intact Object.prototype is re-asked on every query, never folded into the cached answer.
  const { file, checker, flow, ledger, closed } = setup(SET_VALUES('texture.setValues( { wrapS: 1 } );'), true, true)
  const array = receiverOf(file, 'mipmaps')
  let asked = 0
  let intactNow = true
  const keySets: ComputedKeySetAuthority = {
    ...authorityOf(checker, flow, closed),
    intrinsicIntact: (intrinsic) => {
      asked += 1
      return intrinsic === 'Object' && intactNow
    }
  }
  const query = () => ledger!.capture(() => arrayStoredValuesOf(checker, flow, array, keySets)).value
  assert.deepEqual(
    query()?.map((node) => node.getText(file)),
    ['mipmap']
  )
  const first = asked
  assert.ok(first > 0)
  intactNow = false
  assert.equal(query(), null)
  assert.ok(asked > first)
})

/** Three's `CompressedTexture`: the field is initialised from a constructor parameter, forwarded by a subclass's `super`. */
const COMPRESSED = `class Texture {
    mipmaps: object[] = [];
    copy(source: Texture) { this.mipmaps = source.mipmaps.slice(0); return this }
  }
  class CompressedTexture extends Texture { constructor(mipmaps: object[]) { super(); this.mipmaps = mipmaps } }
  class CompressedArrayTexture extends CompressedTexture { constructor(mipmaps: object[]) { super(mipmaps) } }
  const first = {}; const second = {};
  const levels = [first];
  new CompressedTexture(levels);`

test('a field initialised from a constructor parameter holds its arguments over every construction', () => {
  assert.deepEqual(stored(`${COMPRESSED} new CompressedArrayTexture([second]); ${READ}`, { receiver: 't.mipmaps' }), ['first', 'second'])
  // A constructor no construction runs binds nothing.
  assert.deepEqual(stored(`${COMPRESSED} ${READ}`, { receiver: 't.mipmaps' }), ['first'])
  for (const extra of [
    // An argument with no enumerable origin.
    'declare function source(): object[]; new CompressedTexture(source());',
    // A spread fills the position with anything.
    'declare const rest: [object[]]; new CompressedTexture(...rest);',
    // A construction this layer cannot attribute to a constructor.
    'declare const Make: typeof CompressedTexture; new Make([second]);',
    // The parameter's array handed to unknown code.
    'declare function unknownConsumer(value: unknown): void; class Leaky extends Texture { constructor(mipmaps: object[]) { super(); this.mipmaps = mipmaps; unknownConsumer(mipmaps) } } new Leaky([second]);'
  ])
    assert.equal(stored(`${COMPRESSED} ${extra} ${READ}`, { receiver: 't.mipmaps' }), null, extra)
})

test('provenance decides what an untyped or loosely typed receiver may hold', () => {
  // EventDispatcher's `listeners[ type ] = []`: the receiver is typed loosely,
  // but the only value ever reaching it is a literal, which no family instance is.
  const registry = (table: string) =>
    `${TEXTURE} class Registry { table = ${table}; add(type: string) { const listeners: any = this.table; listeners[type] = [second] } }
    new Registry().add('x'); ${READ}`
  assert.deepEqual(stored(registry('{}'), { receiver: 't.mipmaps' }), ['mipmap', 'second'])
  // The complete caller frame proves this store names only `x`, even when
  // its receiver is a family instance. An unbounded key still refuses.
  assert.deepEqual(stored(registry('texture as {}'), { receiver: 't.mipmaps' }), ['mipmap', 'second'])
  assert.equal(stored(registry('texture as {}').replace(".add('x')", '.add(globalThis.key)'), { receiver: 't.mipmaps' }), null)
  assert.deepEqual(stored(`declare function source(): any; ${registry('source()')}`, { receiver: 't.mipmaps' }), ['mipmap', 'second'])
  assert.equal(
    stored(`declare function source(): any; ${registry('source()').replace(".add('x')", '.add(globalThis.key)')}`, {
      receiver: 't.mipmaps'
    }),
    null
  )
  // An `any` parameter whose closed callers only pass family instances names the field.
  const upload = 'function upload(texture: any, level: number) { const local = texture.mipmaps; local.push(level); return local[level] }'
  assert.deepEqual(stored(`${TEXTURE} ${upload} upload(texture, 0); ${READ}`, { receiver: 't.mipmaps' }), ['level', 'mipmap', 'second'])
  // Published to unknown code, or handed a value of unknown origin, it stays open.
  assert.equal(
    stored(`${TEXTURE} ${upload} upload(texture, 0); (globalThis as any).hook = upload; ${READ}`, { receiver: 't.mipmaps' }),
    null
  )
  assert.equal(stored(`${TEXTURE} ${upload} declare const loose: any; upload(loose, 0); ${READ}`, { receiver: 't.mipmaps' }), null)
})

test('field stores, reads and family members no authority can account for refuse', () => {
  for (const extra of [
    // A store through a receiver no authority attributes to a family or away from one.
    'declare const loose: any; loose.mipmaps = [second];',
    // A subclass that runs code for the key.
    'class Weird extends Texture { get mipmaps(): object[] { return [] } set mipmaps(value: object[]) {} }',
    'class Weird extends Texture { mipmaps() { return [] } }',
    // A computed key that may spell the field.
    'declare const key: string; texture[key] = [second];',
    // The field's array handed to, or returned into, unknown code.
    'declare function unknownConsumer(value: unknown): void; unknownConsumer(texture.mipmaps);',
    // (A function no call reaches is dead code: its `return` hands nothing out.)
    'function leak(t: Texture) { return t.mipmaps } leak(texture);',
    'texture.mipmaps.forEach(() => {});',
    // A family whose instances are not all enumerated.
    'declare const Make: new () => Texture; const made = new Make();',
    'declare function unknownConsumer(value: unknown): void; unknownConsumer(CompressedTexture);',
    // A store whose value has no enumerable origin.
    'declare function source(): object[]; texture.mipmaps = source();',
    // Aliases no reference names: destructuring, own-property copies and reflection.
    'const { mipmaps } = texture;',
    'function take({ mipmaps }: Texture) { return mipmaps }',
    'const copied = { ...texture };',
    'Object.assign(texture, { mipmaps: [second] });',
    'const all = Object.values(texture);',
    'const values = Object.values; values(unrelated);'
  ])
    assert.equal(stored(`${TEXTURE} ${extra} ${READ}`, { receiver: 't.mipmaps' }), null, extra)
  // `a.k` on `A | B` names two different cells when both declare `k`.
  assert.equal(
    stored(`${TEXTURE} class Other { mipmaps: object[] = [] } declare const either: Texture | Other; either.mipmaps[0];`, {
      receiver: 'either.mipmaps'
    }),
    null
  )
})

test('index keys the checker cannot type need the caller numeric authority', () => {
  const source = 'const first = {}; const items = [first]; function read(index: any) { return items[index] }'
  assert.equal(stored(source), null)
  assert.deepEqual(stored(source, { numeric: true }), ['first'])
})

test('a native map slot continues the family through every read of that map', () => {
  // Three's `WebGLRenderLists.get`: the array is stored by `set` and read back
  // by `get`, and the reuse arm pushes into whatever came back.
  const source = `const lists = new WeakMap<object, object[]>();
    function get(scene: object, depth: number) {
      const listArray = lists.get(scene);
      let list: object;
      if (listArray === undefined) { list = {}; lists.set(scene, [list]); }
      else if (depth >= listArray.length) { list = {}; listArray.push(list); }
      else { list = listArray[depth]; }
      return list;
    }
    get({}, 0);`
  assert.deepEqual(stored(source, { receiver: 'listArray' }), ['list', 'list'])
  assert.equal(
    stored(source.replace('get({}, 0);', 'declare function external(value: unknown): void; external(lists);'), { receiver: 'listArray' }),
    null
  )
  assert.equal(
    stored(source.replace('lists.set(scene, [list]);', 'lists.set(scene, [list]); lists.forEach(() => {});'), { receiver: 'listArray' }),
    null
  )
})

test('opaque publication, reflection, callbacks and non-element members refuse', () => {
  const prefix = 'declare function external(value: unknown): void; const first = {}; const items: any[] = [first];'
  for (const use of [
    'external(items);',
    'const alias = items; external(alias);',
    'items.forEach(external);',
    'items.map((item) => item);',
    'external(...items);',
    'export { items };',
    'export default items;',
    'Object.freeze(items);',
    'Reflect.set(items, 0, first);',
    'for (const key in items) {}',
    'declare const key: string; items[key];',
    'const push = items.push;',
    'items.push = () => 0;',
    'function leak() { return items }',
    '[items[0]] = [first];',
    'items[0] += 1;',
    'items[0]++;',
    'items[0]();',
    'const bag = { items };',
    'const nested = [items];',
    'external(items.entries());',
    'const copy = items.fill(first); external(copy);',
    'items.length++;'
  ])
    assert.equal(stored(`${prefix} ${use} items[0];`), null, use)
  assert.equal(stored('const first = {}; export const items = [first]; items[0];'), null)
})

test('unknown or unseeded origins never become a partial stored-value set', () => {
  const prefix = 'declare function source(): object[]; declare const choose: boolean; const first = {};'
  for (const origin of [
    'const items = source();',
    'let items = [first]; items = source();',
    'let items: any; items = items;',
    'let a: any; let b: any; a = b; b = a; const items = choose ? a : [first];',
    'const items = [...source()];',
    'const items = source().slice(0);',
    'const items = [first].concat(source());',
    'const items = Array.from([first], (value) => value);',
    'const items = null;'
  ])
    assert.equal(stored(`${prefix} ${origin} items[0];`), null, origin)
})

test('intrinsic Array protocol integrity is re-asked on every query', () => {
  const { file, checker, flow, ledger, closed } = setup('const first = {}; const items = [first]; items[0];', true)
  const array = receiverOf(file, 'items')
  const authority = authorityOf(checker, flow, closed)
  for (let round = 0; round < 2; round += 1) {
    const { value, requirements } = ledger!.capture(() => arrayStoredValuesOf(checker, flow, array, authority))
    assert.deepEqual(
      value?.map((node) => node.getText(file)),
      ['first']
    )
    assert.ok(
      requirements.some((requirement) => requirement.intrinsic === 'Array'),
      `round ${round}`
    )
  }
  assert.equal(
    arrayStoredValuesOf(
      checker,
      flow,
      array,
      authorityOf(checker, flow, () => false)
    ),
    null
  )
})

test('a parameter inventory joins empty and nonempty caller arrays and replays obligations', () => {
  const { file, checker, flow, ledger, closed } = setup(
    "function fill(xs: any[]) { xs.push(1) } const empty = []; const nonempty = ['bad']; fill(empty); fill(nonempty);",
    true
  )
  let parameter: ts.ParameterDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.name.getText(file) === 'xs') parameter = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(parameter && ts.isIdentifier(parameter.name))
  const receiver = parameter.name
  const authority = authorityOf(checker, flow, closed)
  for (let round = 0; round < 2; round += 1) {
    const { value, requirements } = ledger!.capture(() => arrayStoredValuesOf(checker, flow, receiver, authority))
    assert.deepEqual(value?.map((node) => node.getText(file)).sort(), ["'bad'", '1'])
    assert.ok(
      requirements.some((requirement) => requirement.intrinsic === 'Array'),
      `round ${round}`
    )
  }
})

test('a cached inventory replays every deferred intrinsic obligation, including Function', () => {
  const { file, checker, flow, ledger, closed } = setup(
    'function fill(xs: any[]) { xs.push(1) } const items = []; fill(items); items[0];',
    true
  )
  const parameter = file.statements
    .flatMap((statement) => (ts.isFunctionDeclaration(statement) ? statement.parameters : []))
    .find((candidate) => candidate.name.getText(file) === 'xs')
  assert.ok(parameter && ts.isIdentifier(parameter.name))
  const base = authorityOf(checker, flow, closed)
  const authority: OriginAuthority = {
    ...base,
    parameterValuesOf: (candidate) => {
      ledger!.require('Function', candidate)
      return base.parameterValuesOf(candidate)
    }
  }
  const receiver = parameter.name
  for (let round = 0; round < 2; round += 1) {
    const result = ledger!.capture(() => arrayStoredValuesOf(checker, flow, receiver, authority))
    assert.deepEqual(
      result.value?.map((node) => node.getText(file)),
      ['1']
    )
    assert.ok(
      result.requirements.some((requirement) => requirement.intrinsic === 'Function'),
      `round ${round}`
    )
  }
})

test('an array passed to an opaque callee refuses parameter inventory publication', () => {
  const { file, checker, flow, ledger, closed } = setup(
    'declare function opaque(value: any): void; function fill(xs: any[]) { xs.push(1) } const empty = []; opaque(empty); fill(empty);',
    true
  )
  let parameter: ts.ParameterDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.name.getText(file) === 'xs') parameter = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(parameter && ts.isIdentifier(parameter.name))
  const receiver = parameter.name
  const { value } = ledger!.capture(() => arrayStoredValuesOf(checker, flow, receiver, authorityOf(checker, flow, closed)))
  assert.equal(value, null)
})

test('closed protocol proof observes prototype overrides and global escapes', () => {
  const prefix = 'declare function external(value: unknown): void; const items = [1]; items.push(2);'
  assert.deepEqual(stored(`${prefix} items[0];`, { deferred: false }), ['1', '2'])
  for (const extra of [
    'Array.prototype.push = () => 0;',
    'const global = globalThis; external(global);',
    'const ctor = Array; external(ctor);'
  ])
    assert.equal(stored(`${prefix} ${extra} items[0];`, { deferred: false }), null, extra)
})
