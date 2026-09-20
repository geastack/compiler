import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusParameterBindings, indexParameterBindingProgram } from './parameter-bindings.js'
import { wholeProgram } from './reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'

/**
 * Three's render lists, reduced: a drawn mesh goes into a pooled record
 * (`getNextRenderItem`), the record into a per-list array, the list into a
 * per-scene array held in a `WeakMap`, and the current list onto a stack --
 * then comes back out of every one of those to be drawn. The mesh's own
 * callback is typed from that one draw call only if every one of those
 * containers is proven never to reach unknown code.
 */
interface Injection {
  /** Statements appended to `RenderList`'s factory body, before its return. */
  readonly list?: string
  /** Statements appended to `RenderLists`' factory body, before its return. */
  readonly lists?: string
  /** Statements appended to the frame, after the lists are drawn. */
  readonly frame?: string
  /** Statements run in the pooled-record creation branch. */
  readonly created?: string
  /** Statements run in the pooled-record reuse branch. */
  readonly reused?: string
}

const infer = (injection: Injection = {}) => {
  const entry = resolve('test/fixtures/array-record-element-member.js')
  const source = `export {};
    class Mesh {
      constructor() { this.id = 1; this.onDraw = function(input) { return input.amount; }; }
    }
    function painterSortStable(a, b) { return a.id - b.id; }
    function RenderList() {
      const renderItems = [];
      let renderItemsIndex = 0;
      const opaque = [];
      function init() { renderItemsIndex = 0; opaque.length = 0; }
      function getNextRenderItem(object) {
        let renderItem = renderItems[renderItemsIndex];
        if (renderItem === undefined) {
          renderItem = { id: object.id, object: object };
          renderItems[renderItemsIndex] = renderItem;
          ${injection.created ?? ''}
        } else {
          renderItem.id = object.id;
          renderItem.object = object;
          ${injection.reused ?? ''}
        }
        renderItemsIndex++;
        return renderItem;
      }
      function push(object) { const renderItem = getNextRenderItem(object); opaque.push(renderItem); }
      function unshift(object) { const renderItem = getNextRenderItem(object); opaque.unshift(renderItem); }
      function sort(customOpaqueSort, reversed) {
        if (opaque.length > 1) opaque.sort(customOpaqueSort || painterSortStable);
        if (reversed) opaque.reverse();
      }
      function finish() {
        for (let i = renderItemsIndex, il = renderItems.length; i < il; i++) {
          const renderItem = renderItems[i];
          if (renderItem.id === null) break;
          renderItem.id = null;
          renderItem.object = null;
        }
      }
      ${injection.list ?? ''}
      return { opaque: opaque, init: init, push: push, unshift: unshift, finish: finish, sort: sort };
    }
    function RenderLists() {
      let lists = new WeakMap();
      function get(scene, renderCallDepth) {
        const listArray = lists.get(scene);
        let list;
        if (listArray === undefined) {
          list = new RenderList();
          lists.set(scene, [list]);
        } else {
          if (renderCallDepth >= listArray.length) {
            list = new RenderList();
            listArray.push(list);
          } else {
            list = listArray[renderCallDepth];
          }
        }
        return list;
      }
      ${injection.lists ?? ''}
      return { get: get };
    }
    /** @param {Array<{object: Mesh}>} renderList */
    function renderObjects(renderList) {
      for (let i = 0, l = renderList.length; i < l; i++) {
        const renderItem = renderList[i];
        const { object } = renderItem;
        object.onDraw({ amount: 7 });
      }
    }
    let opaqueSort = null;
    /** @type {ReturnType<typeof RenderLists>} */
    const renderLists = new RenderLists();
    /** @type {Array<ReturnType<typeof RenderList>>} */
    const renderListStack = [];
    /** @type {ReturnType<typeof RenderList> | null} */
    let currentRenderList = null;
    const scene = {};
    const mesh = new Mesh();
    function frame() {
      currentRenderList = renderLists.get(scene, renderListStack.length);
      currentRenderList.init();
      renderListStack.push(currentRenderList);
      currentRenderList.push(mesh);
      currentRenderList.unshift(mesh);
      currentRenderList.finish();
      currentRenderList.sort(opaqueSort, false);
      const { opaque: opaqueObjects } = currentRenderList;
      if (opaqueObjects.length > 0) renderObjects(opaqueObjects);
      for (const item of opaqueObjects.slice(0)) console.log(item.id);
      ${injection.frame ?? ''}
      renderListStack.pop();
      currentRenderList = renderListStack.length > 0 ? renderListStack[renderListStack.length - 1] : null;
    }
    frame();
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
    if (
      ts.isFunctionExpression(node) &&
      ts.isBinaryExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.left) &&
      node.parent.left.name.text === 'onDraw'
    )
      callback = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(callback)
  return { checker, type: census.typeAt(callback.parameters[0]!), debug: census.debugReport?.() }
}

const refused = (type: ts.Type | null | undefined): boolean => !type || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0

// Open: the `push` slot's own closure proof stops, silently, at
// `renderListStack[renderListStack.length - 1]` (a repeated-element summary path
// at a conditional's operand). Fail-closed, so only the positive waits.
const LIST_STACK_SUMMARY_OPEN = 'push slot closure stops at renderListStack[renderListStack.length - 1]'
test(
  'a mesh drawn through pooled render items, per-list arrays, a per-scene map and a list stack keeps its callback frame',
  { todo: LIST_STACK_SUMMARY_OPEN },
  () => {
    const result = infer()
    assert.ok(result.type && !refused(result.type), result.debug)
    const amount = result.checker.getPropertyOfType(result.type, 'amount')
    assert.ok(amount)
    assert.ok((result.checker.getTypeOfSymbolAtLocation(amount, amount.valueDeclaration!).flags & ts.TypeFlags.NumberLike) !== 0)
  }
)

test('every escape of the render-list chain refuses the mesh callback frame', () => {
  const escapes: readonly (readonly [string, Injection])[] = [
    ['current list opaque array', { frame: 'globalThis.unknownConsumer(currentRenderList.opaque);' }],
    ['opaque element', { frame: 'globalThis.unknownConsumer(opaqueObjects[0]);' }],
    ['opaque element object', { frame: 'globalThis.unknownConsumer(opaqueObjects[0].object);' }],
    ['forEach into unknown code', { frame: 'opaqueObjects.forEach(globalThis.external);' }],
    ['sort with an unknown comparator', { frame: 'opaqueObjects.sort(globalThis.external);' }],
    ['array spread into unknown code', { frame: 'globalThis.unknownConsumer([...opaqueObjects]);' }],
    ['call spread into unknown code', { frame: 'globalThis.unknownConsumer(...opaqueObjects);' }],
    ['slice result escaping', { frame: 'globalThis.unknownConsumer(opaqueObjects.slice(0));' }],
    ['concat result escaping', { frame: 'globalThis.unknownConsumer(opaqueObjects.concat([]));' }],
    ['concat argument escaping', { frame: 'globalThis.unknownConsumer([].concat(opaqueObjects));' }],
    ['splice result escaping', { frame: 'globalThis.unknownConsumer(opaqueObjects.splice(0, 1));' }],
    ['pop result escaping', { frame: 'globalThis.unknownConsumer(opaqueObjects.pop());' }],
    ['find with an unknown predicate', { frame: 'opaqueObjects.find(globalThis.external);' }],
    ['find result escaping', { frame: 'globalThis.unknownConsumer(opaqueObjects.find((item) => item.id === 1));' }],
    ['array destructuring into unknown code', { frame: 'const [first] = opaqueObjects; globalThis.unknownConsumer(first);' }],
    ['list stack', { frame: 'globalThis.unknownConsumer(renderListStack);' }],
    ['render lists record', { frame: 'globalThis.unknownConsumer(renderLists);' }],
    ['per-scene map', { lists: 'globalThis.unknownConsumer(lists);' }],
    [
      'pooled record alias kept at creation',
      { list: 'const keep = []; globalThis.unknownConsumer(keep);', created: 'keep.push(renderItem);' }
    ],
    ['pooled record alias kept at reuse', { list: 'const keep = []; globalThis.unknownConsumer(keep);', reused: 'keep.push(renderItem);' }],
    ['non-numeric index', { frame: 'globalThis.unknownConsumer(opaqueObjects[globalThis.key]);' }],
    ['reflected keys', { frame: 'globalThis.unknownConsumer(Object.keys(opaqueObjects));' }],
    ['arguments leak', { list: 'function leak(list) { globalThis.unknownConsumer(arguments); } leak(opaque);' }],
    // A sibling read runs whatever the object read from holds under the key.
    // A pooled trap with a getter is reused as a render item; a twin of the
    // item's shape gets the mesh through a field store; and a self backlink
    // hands the item back out through a slot the mesh is not in.
    [
      'getter sibling on a pooled item',
      { list: 'const trap = { get id() { globalThis.unknownConsumer(this); return 1; }, object: null }; renderItems.push(trap);' }
    ],
    [
      'getter twin filled by a field store',
      {
        created:
          'const twin = { get id() { globalThis.unknownConsumer(this); return 1; }, object: null }; twin.object = object; opaque.push(twin);'
      }
    ],
    ['self backlink', { created: 'renderItem.self = renderItem;', frame: 'globalThis.unknownConsumer(opaqueObjects[0].self);' }]
  ]
  for (const [name, injection] of escapes) assert.ok(refused(infer(injection).type), name)
})

test('a module-level list stack keeps its elements closed until an export publishes it', () => {
  // `export` cannot sit inside the frame body, so the exported alias is its
  // own module: the same stack, once kept local and once published.
  const local = inferStack('')
  assert.ok(local.type && !refused(local.type), local.debug)
  assert.ok(refused(inferStack('export const exposed = stack;').type), 'exported alias')
})

test('an exported factory keeps its callers open wherever its export can reach unknown code', () => {
  // `make`'s result is the tracked instance, so its callers are the
  // instance's aliases. An importer publishing the binding, a namespace
  // publishing the module, a renamed re-export and a dynamic import each hand
  // `make` to code that can call it; none of them is a caller this program
  // names.
  const owner = `export class Renderer { constructor() { this.draw = function(input) { return input.amount; }; } }
    export function make() { return new Renderer(); }`
  const escapes: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    [
      'named import published',
      { entry: `import { make } from './owner.js'; const held = make(); held.draw({ amount: 7 }); globalThis.unknownConsumer(make);` }
    ],
    [
      'namespace published',
      { entry: `import * as ns from './owner.js'; const held = ns.make(); held.draw({ amount: 7 }); globalThis.unknownConsumer(ns);` }
    ],
    [
      'renamed re-export chain',
      {
        middle: `export { make as build } from './owner.js';`,
        entry: `import { build } from './middle.js'; const held = build(); held.draw({ amount: 7 }); globalThis.unknownConsumer(build);`
      }
    ],
    [
      'dynamic import',
      {
        entry: `import { make } from './owner.js'; const held = make(); held.draw({ amount: 7 });
          import('./owner.js').then((loaded) => globalThis.unknownConsumer(loaded.make));`
      }
    ]
  ]
  for (const [name, modules] of escapes) assert.ok(refused(inferModules({ owner, ...modules }).type), name)
})

/** A multi-module program; the callback is the one function expression in `owner`. */
const inferModules = (modules: Readonly<Record<string, string>>) => {
  const sources = new Map(Object.entries(modules).map(([name, text]) => [resolve(`test/fixtures/array-record-element-${name}.js`), text]))
  const renamed = (text: string): string => text.replace(/'\.\/(owner|middle)\.js'/g, "'./array-record-element-$1.js'")
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => sources.has(resolve(name)) || fileExists(name)
  host.getSourceFile = (name, version, ...rest) =>
    sources.has(resolve(name))
      ? ts.createSourceFile(name, renamed(sources.get(resolve(name))!), version, true, ts.ScriptKind.JS)
      : original(name, version, ...rest)
  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter((file) => sources.has(resolve(file.fileName)))
  const index = indexParameterBindingProgram(checker, files, wholeProgram)
  attachDeferredIntrinsicProtocolLedger(index.valueFlow, createDeferredIntrinsicProtocolLedger())
  const census = censusParameterBindings(checker, files, wholeProgram, undefined, index)
  let callback: ts.FunctionExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node)) callback = node
    ts.forEachChild(node, visit)
  }
  visit(program.getSourceFile(resolve('test/fixtures/array-record-element-owner.js'))!)
  assert.ok(callback)
  return { checker, type: census.typeAt(callback.parameters[0]!), debug: census.debugReport?.() }
}

const inferStack = (tail: string) => {
  const entry = resolve('test/fixtures/array-record-element-member-stack.js')
  const source = `export {};
    class Mesh { constructor() { this.onDraw = function(input) { return input.amount; }; } }
    /** @param {Array<Mesh>} list */
    function draw(list) { for (let i = 0; i < list.length; i++) list[i].onDraw({ amount: 7 }); }
    const stack = [];
    stack.push(new Mesh());
    draw(stack);
    ${tail}
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
