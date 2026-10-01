import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const fixture = resolve(root, 'test/runtime/dynamic-fallback.js')

test('negative-array source retains Proxy behavior and target identity in the C++ fallback', () => {
  const strict = compile({ rootFileNames: [fixture], javaScriptSources: true })
  assert.equal(strict.source, null)
  assert.match(JSON.stringify(strict.diagnostics), /ProxyConstructor/)
  const result = compile({ rootFileNames: [fixture], javaScriptSources: true, dynamicFallback: true })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const binary = resolve(root, `measurements/dynamic-fallback${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `${result.source}\nint main() { try { __gea_top_level(); } catch (const gea::Value& error) { std::fprintf(stderr, "%s", gea::host::runtimeErrorString(error).c_str()); return 1; } }\n`,
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  const expected = execFileSync(process.execPath, [fixture], { encoding: 'utf8' })
  assert.equal(execFileSync(binary, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }), expected)
})

test('prototype reassignment and prototype-method definition on a plain JS constructor function', () => {
  const file = resolve(root, 'test/runtime/dynamic-fallback-prototype.js')
  const result = compile({ rootFileNames: [file], javaScriptSources: true, dynamicFallback: true })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics.filter((d) => d.severity === 'root')))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const binary = resolve(root, `measurements/dynamic-fallback-prototype${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `${result.source}\nint main() { try { __gea_top_level(); } catch (const gea::Value& error) { std::fprintf(stderr, "%s", gea::host::runtimeErrorString(error).c_str()); return 1; } }\n`,
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  const expected = execFileSync(process.execPath, [file], { encoding: 'utf8' })
  assert.equal(execFileSync(binary, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }), expected)
})

const cases = [
  [
    'readonly return view',
    `/** @returns {ReadonlyArray<string>} */ function view(p){return p} const target=['a']; const p=new Proxy(target,{get(t,k,r){return k==='0'?'z':Reflect.get(t,k,r)}}); const readonly=view(p); console.log(readonly[0],target[0]);`
  ],
  [
    'array callbacks and sidecars',
    `import negativeArray from './negative-array.js'; const source=['a','b','c']; const p=negativeArray(source); const key=Symbol('key'); p[key]='symbol'; p.extra='extra'; console.log(p.map(value=>value+'!').join('|'),p.filter(value=>value==='b').join(','),p.slice(1).join(',')); console.log(p[key],Reflect.get(source,key),p.extra);`
  ],
  ['dynamic addition', `function add(a,b){return a+b} console.log(add(2,3),add('a',3));`],
  ['invalid target', `try { new Proxy(1,{}); } catch(e) { console.log(e.name); }`],
  [
    'frozen target invariant',
    `const target={x:7}; Object.freeze(target); const p=new Proxy(target,{get(){return 9}}); try { console.log(p.x); } catch(e) { console.log(e.name); }`
  ],
  ['own keys', `const target={x:7,y:8}; const p=new Proxy(target,{ownKeys(){return ['y','x']}}); console.log(Object.keys(p).join(','));`],
  [
    'shadowed builtins',
    `export {}; const Reflect={get(){return 17}}; class Proxy { constructor(target,handler){this.x=target.x} } const p=new Proxy({x:3},{}); console.log(p.x,Reflect.get());`
  ],
  [
    'typed object',
    `const target={count:1}; const proxy=new Proxy(target,{get(t,k,r){return k==='count'?9:Reflect.get(t,k,r)}}); console.log(proxy.count,target.count);`
  ],
  ['typed array', `const a=['a','b']; const p=new Proxy(a,{}); p[0]='z'; console.log(a[0],p[1]);`],
  [
    'handler receiver',
    `const target={count:1}; const handler={offset:3, get(t,k){return this.offset}}; const p=new Proxy(target,handler); console.log(p.count);`
  ],
  [
    'array method receiver',
    `import negativeArray from './negative-array.js'; const a=['a','b']; const p=negativeArray(a); console.log(p.push('c'), p[-1], a[2]); console.log(p.pop(),p.length);`
  ],
  [
    'nested proxies',
    `const target={x:7}; const p=new Proxy(new Proxy(target,{}),{get(t,k,r){return Reflect.get(t,k,r)}}); console.log(p.x);`
  ],
  [
    'has and delete traps',
    `const target={x:7}; const p=new Proxy(target,{has(t,k){return k==='other'},deleteProperty(t,k){return Reflect.deleteProperty(t,k)}}); console.log('other' in p); console.log(delete p.x,'x' in target);`
  ],
  [
    'prototype reached through a parameter',
    `function link(ctor,sup){ Object.defineProperty(ctor,'super_',{value:sup,writable:true,configurable:true}); Object.setPrototypeOf(ctor.prototype,sup.prototype) } function Base(){this.b=1} Base.prototype.hello=function(){return 'hi '+this.b}; function Child(){Base.call(this); this.c=2} link(Child,Base); const x=new Child(); console.log(x.hello(),x.c,Child.super_===Base);`
  ],
  [
    'records held by a dynamically returned record keep identity',
    `const INTS=()=>[{type:2,from:48,to:57}]; const box=/** @type {any} */ ({}); box.ints=()=>({type:3,set:INTS(),not:false}); function span(tokens){let n=0; for (const t of tokens) n+=t.to-t.from; return n} console.log(span(box.ints().set),INTS()[0].from);`
  ],
  [
    'exec on a boxed global regexp',
    `const holder=/** @type {any} */ ({}); holder.re=/(a)|(b)/g; const out=[]; let m; while ((m=holder.re.exec('ab'))!==null) out.push(m[0],String(m[1]),String(m[2]),m.index,m.input,m.groups===undefined); console.log(out.join(','),holder.re.exec('zz'),holder.re.lastIndex);`
  ],
  [
    'capture slots of a match read as undefined when the group did not participate',
    `const exec=RegExp.prototype.exec; const regexp=/(a)|(b)/g; let rs; const out=[]; while ((rs=regexp.exec('ab'))!==null) { const p=(rs[1] && 'first') ?? (rs[2] && 'second'); out.push(String(p),rs.index); } console.log(out.join(','),regexp.lastIndex,typeof exec);`
  ],
  [
    'a destructured parameter handed a box without one of its members',
    `function wrap(r, { a, b }) { return a === undefined ? b + r : a } const opts = /** @type {any} */ ({ b: 2 }); console.log(wrap(1, opts));`
  ],
  [
    'a boxed object handed to a parameter stated as a named record',
    `/** @typedef {{ limit?: number, nested?: { flag?: boolean }, make?: (n: number) => string }} Options */ /** @param {Options} options */ function setup(options) { return [options.limit, options.nested?.flag, typeof options.make, Object.hasOwn(options, 'limit')].join(',') } function process(options) { options = Object.assign({}, options); options.limit = options.limit || 7; options.nested = Object.assign({}, options.nested); return options } console.log(setup(/** @type {Options} */ (process({ nested: { flag: true } }))), setup(/** @type {Options} */ (process({ limit: 3, make: (n) => String(n) }))));`
  ],
  [
    'an untyped argument at a plain object statement keeps the members the statement omits',
    `/** @typedef {{ logger?: boolean | { level?: string } }} Options */ /** @param {Options} options */ function setup(options) { return options.logger.child('x').level } function process(options) { options = Object.assign({}, options); options.logger = { level: 'info', child: (name) => ({ level: name + ':info' }) }; return { options } } const { options } = process({ logger: false }); console.log(setup(options));`
  ],
  [
    'an object spread over a widened stated parameter is a dynamic object',
    `/** @param {{ url: string, method?: string }} options */ function req(options) { const o = { ...options, Request: undefined }; return o.url + ':' + String(o.method) + ':' + String(o.Request) } function mk(x) { return req(x) } console.log(mk(JSON.parse('{"url":"/"}')), mk(JSON.parse('{"url":"/a","method":"GET"}')));`
  ],
  [
    'a destructured parameter stated as a plain object and handed an untyped member reads the box',
    `/** @typedef {{ url?: string, handler?: () => string }} RouteOptions */ /** @param {{ options: RouteOptions, isFastify: boolean }} */ function route({ options, isFastify }) { const opts = { ...options }; opts.extra = 1; return addNewRoute.call(this, { path: opts.url + ':' + opts.handler() + ':' + opts.extra, isFastify }); function addNewRoute({ path, prefixing = false, isFastify = false }) { return path + ':' + String(prefixing) + ':' + String(isFastify) } } function prepare({ url, options, handler, isFastify }) { options = Object.assign({}, options, { url, handler }); return route.call(this, { options, isFastify }) } const app = { get: function (url, options, handler) { return prepare.call(this, { url, options, handler }) } }; console.log(app.get('/', JSON.parse('{"k":1}'), () => 'h'));`
  ],
  [
    'a plain object handed to a union whose one object arm is a record materializes that arm',
    `/** @param {boolean | { level?: string, levels?: { values?: Record<string, number> } }} l */ function v(l) { if (l?.levels?.values == null) return typeof l === 'object' ? 'obj:' + String(l.level) : String(l); return String(l.levels.values.info) } const o = Object.assign({}, { level: 'i', child() { return 1 } }); const p = Object.assign({}, { levels: { values: { info: 30 } } }); console.log(v(o), v(true), v(p));`
  ],
  [
    'a dynamically called method returning null answers null',
    `function Router() { this.trees = {} } Router.prototype.findRoute = function findNode (method, path, constraints = {}) { if (this.trees[method] === undefined) { return null } return { handler: path } }; const r = /** @type {any} */ (new Router()); r.trees.GET = 1; const a = r.findRoute('HEAD', '/'); const b = r.findRoute('GET', '/x'); console.log(a === null, a === undefined, b && b.handler);`
  ],
  [
    'a container read off a boxed instance is the stored object, not a copy',
    `function StaticNode(p) { this.prefix = p; this.kids = {} } function Router() { this.trees = Object.create(null); this._treeGET = null } Router.prototype.on = function (method, path) { if (this.trees[method] === undefined) { this.trees[method] = new StaticNode('/') } const node = this.trees[method]; if (method === 'GET') this._treeGET = node; node.kids[path] = 1; return node.prefix.length + Object.keys(this.trees[method].kids).length }; const r = new Router(); console.log(r.on('GET', '/a'), r.on('GET', '/b'), r._treeGET.prefix);`
  ],
  [
    'a method read through a container read off a boxed instance keeps its receiver',
    `function Boot() { this._current = [] } Boot.prototype.push = function (p) { const last = this._current[0]; this._current.unshift(p); return this._current.length + ':' + String(last) }; const b = new Boot(); console.log(b.push('a'), b.push('b'), b._current.join(','));`
  ],
  [
    'a receiver-taking function returned through a boxed call keeps its receiver slot',
    `function encapsulate(func, that) { const wrapped = inner; return wrapped; function inner(err, cb) { if (func.length === 2) return func(err, cb); return func(err, this, cb) } } const box = JSON.parse('{}'); box.encapsulate = encapsulate; const w = box.encapsulate((err, done) => typeof done, {}); console.log(w(null, () => 1));`
  ],
  [
    'a bound function adapted to a typed callable keeps its length',
    `const f0 = new Function('return 0'); function wrap(func, that) { const wrapped = inner.bind(that); wrapped.unwrappedName = func.name; return wrapped; function inner(err, cb) { return func.length === 2 ? func(err, cb) : 'x' } } function run(func, cb) { if (func.length === 0) return 'zero:' + String(func()); return func(null, cb) } const w = wrap((err, done) => typeof done, {}); console.log(f0(), run(w, () => 1), w.length);`
  ],
  [
    'Object.create over a compiled instance reads that instance live',
    `function Context(send) { this.onSend = send; this.config = { url: '/' } } const c = new Context('base'); const holder = JSON.parse('{}'); holder.ctx = c; const derived = Object.create(holder.ctx); derived.onSend = 'own'; c.config = { url: '/x' }; console.log(derived.onSend, derived.config.url, c.onSend, 'config' in derived);`
  ],
  [
    'a local compared with undefined keeps the undefined its untyped write stores',
    `class Lru { constructor() { this.items = new Map() } get(k) { return this.items.get(k) } set(k, v) { this.items.set(k, v) } } /** @type {Lru<CT>} */ const cache = /** @type {any} */ (new Lru()); class CT { #t = ''; constructor(v) { this.#t = v } static from(h) { let ct = cache.get(h); if (ct !== undefined) return ct; ct = new CT(h); cache.set(h, ct); return ct } get t() { return this.#t } } console.log(CT.from('a').t, CT.from('a').t);`
  ],
  [
    'a local compared loosely with null keeps the undefined its untyped write stores',
    `class Lru { constructor() { this.items = new Map() } get(k) { return this.items.get(k) } set(k, v) { this.items.set(k, v) } } /** @type {Lru<CT>} */ const cache = /** @type {any} */ (new Lru()); class CT { #t = ''; constructor(v) { this.#t = v } static from(h) { let ct = cache.get(h); if (ct != null) return ct; ct = new CT(h); cache.set(h, ct); return ct } get t() { return this.#t } } console.log(CT.from('a').t, CT.from('a').t);`
  ],
  [
    'a keyed read of a dictionary inferred from its writes may read an absent key',
    `class StaticNode { constructor(p) { this.prefix = p } } function Router() { this._treeGET = null; this.trees = Object.create(null) } Router.prototype.on = function (m) { if (this.trees[m] === undefined) this.trees[m] = new StaticNode('/' + m); if (m === 'GET') this._treeGET = this.trees[m] }; Router.prototype.find = function (m) { let n = m === 'GET' ? this._treeGET : this.trees[m]; if (n == null) return null; return n.prefix }; const r = new Router(); console.log(r.find('GET'), r.find('POST')); r.on('GET'); r.on('PUT'); console.log(r.find('GET'), r.find('PUT'), r.find('POST'));`
  ],
  [
    'a class constructor boxed twice is one function',
    `class A {} function same(a,b){return a===b} const o={k:A}; console.log(same(A,A),same(o.k,A),same(A,class {}));`
  ]
]
for (const [name, source] of cases) {
  test(`C++ fallback matches Node: ${name}`, () => {
    const file = resolve(root, 'test/runtime/dynamic-proxy-coverage.js')
    const result = compile({
      rootFileNames: [file],
      sourceOverlay: new Map([[file, source]]),
      javaScriptSources: true,
      dynamicFallback: true
    })
    assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics.filter((d) => d.severity === 'root')))
    assert.deepEqual(result.loweringBlockers, [])
    assert.deepEqual(result.emissionRefusals, [])
    const binary = resolve(root, `measurements/dynamic-fallback${executableSuffix}`)
    execFileSync(
      'clang++',
      [
        '-std=c++20',
        '-O0',
        '-fsanitize=address,undefined',
        `-I${resolve(root, 'src/targets/cpp/runtime')}`,
        '-x',
        'c++',
        '-',
        '-o',
        binary
      ],
      {
        input: `${result.source}\nint main(){ try { __gea_top_level(); } catch (const gea::Value& e) { std::fprintf(stderr,"%s", gea::host::runtimeErrorString(e).c_str()); return 1; } }`,
        stdio: ['pipe', 'pipe', 'inherit']
      }
    )
    const expected = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: resolve(root, 'test/runtime'),
      encoding: 'utf8'
    })
    assert.equal(execFileSync(binary, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }), expected)
  })
}

test('the flag leaves a statically compilable program native', () => {
  const file = resolve(root, 'test/runtime/dynamic-proxy-coverage.js')
  const request = { rootFileNames: [file], javaScriptSources: true, sourceOverlay: new Map([[file, 'const n=3; console.log(n+4);']]) }
  const native = compile(request)
  const fallback = compile({ ...request, dynamicFallback: true })
  assert.ok(native.source)
  assert.equal(fallback.source, native.source)
  assert.deepEqual(fallback.dynamicFallback, { enabled: true, valueCount: 0 })
})

test('C++ proxy runtime preserves invariants, live handlers, receivers and revocation', () => {
  const binary = resolve(root, `measurements/dynamic-proxy-runtime${executableSuffix}`)
  execFileSync(
    'clang++',
    [
      '-std=c++20',
      '-O0',
      '-fsanitize=address,undefined',
      `-I${resolve(root, 'src/targets/cpp/runtime')}`,
      resolve(root, 'test/runtime/dynamic-proxy-runtime.cpp'),
      '-o',
      binary
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  execFileSync(binary, { stdio: ['ignore', 'pipe', 'inherit'] })
})

test('CLI ships the fallback runtime and links both C++ layouts', () => {
  const expected = execFileSync(process.execPath, [fixture], { encoding: 'utf8' })
  for (const layout of ['single', 'per-file']) {
    execFileSync(
      process.execPath,
      [
        resolve(root, 'dist/cli.js'),
        'compile',
        fixture,
        '--out-dir',
        resolve(root, 'measurements'),
        '--dynamic-fallback',
        '--translation-units',
        layout
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const files = readFileSync(resolve(root, 'measurements/geatsc-sources.txt'), 'utf8').trim().split('\n')
    const binary = resolve(root, `measurements/dynamic-fallback-cli${executableSuffix}`)
    execFileSync(
      'clang++',
      ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${resolve(root, 'measurements')}`, ...files, '-x', 'c++', '-', '-o', binary],
      {
        input: 'extern void __gea_top_level(); int main() { __gea_top_level(); }\n',
        stdio: ['pipe', 'pipe', 'inherit']
      }
    )
    assert.equal(execFileSync(binary, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }), expected, layout)
  }
})

test('a boxed function handed to a callable union with a universal arm takes that arm', () => {
  const file = resolve(root, 'test/runtime/callable-union-universal-arm.ts')
  const source =
    "type Generic = (this: unknown, ...args: readonly any[]) => unknown\ntype Typed = (req: string, res: number) => void\nclass Em {\n  generic: Generic[] = []\n  typed: Typed[] = []\n  on(name: 'request', fn: Typed): this\n  on(name: string, fn: Generic): this\n  /** @gea-exact-arms */\n  on(name: string, fn: Generic | Typed): this {\n    if (name === 'request') this.typed.push(fn as Typed)\n    else this.generic.push(fn as Generic)\n    return this\n  }\n  emit(name: string, ...args: any[]): string {\n    return this.generic.map((listener) => String(listener.apply(this, args))).join(',')\n  }\n}\nconst em = new Em()\nem.on('request', (a: string, b: number) => {})\nconst boxed = JSON.parse('{}') as any\nboxed.em = em\nboxed.em.once = undefined\nboxed.em.on('error', function (this: unknown, e: unknown, f: unknown) { return String(e) + String(f) + (this === em) })\nconsole.log(em.emit('error', 'x', 2), em.typed.length)\n"
  const result = compile({ rootFileNames: [file], sourceOverlay: new Map([[file, source]]), dynamicFallback: true })
  assert.ok(result.source, JSON.stringify({ lowering: result.loweringBlockers, emission: result.emissionRefusals }))
  const binary = resolve(root, `measurements/callable-union-universal-arm${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', '-O0', '-I', resolve(root, 'src/targets/cpp/runtime'), '-x', 'c++', '-', '-o', binary], {
    input: result.source + '\nint main(){__gea_top_level();}\n',
    stdio: ['pipe', 'pipe', 'inherit']
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), 'x2true 1\n')
})

test('a boxed plain object handed to a number-or-record parameter through a boxed method takes the record arm', () => {
  const file = resolve(root, 'test/runtime/union-plain-object-argument.ts')
  const source =
    "class Srv {\n  port = 0\n  host = ''\n  listen(portOrOptions: number | { port?: number; host?: string }, cb?: () => void): Srv {\n    if (typeof portOrOptions === 'number') this.port = portOrOptions\n    else { this.port = portOrOptions.port ?? 0; this.host = portOrOptions.host ?? '' }\n    if (cb) cb()\n    return this\n  }\n}\nconst s = new Srv()\nconst boxed = JSON.parse('{}') as any\nboxed.s = s\nboxed.s.listen(JSON.parse('{\"port\":3000,\"host\":\"127.0.0.1\"}'))\nconst t = new Srv()\nboxed.t = t\nboxed.t.listen(8080)\nconsole.log(s.port, s.host, t.port)\n"
  const result = compile({ rootFileNames: [file], sourceOverlay: new Map([[file, source]]), dynamicFallback: true })
  assert.ok(result.source, JSON.stringify({ lowering: result.loweringBlockers, emission: result.emissionRefusals }))
  const binary = resolve(root, `measurements/union-plain-object-argument${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', '-O0', '-I', resolve(root, 'src/targets/cpp/runtime'), '-x', 'c++', '-', '-o', binary], {
    input: result.source + '\nint main(){__gea_top_level();}\n',
    stdio: ['pipe', 'pipe', 'inherit']
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), '3000 127.0.0.1 8080\n')
})

test('a boxed callable whose rest parameter is a fixed tuple is called positionally', () => {
  const file = resolve(root, 'test/runtime/tuple-rest-boxed-callable.ts')
  const source =
    "type H = (...args: [string, number]) => string\nconst rec: { handler: H } = { handler: (a, b) => a + b }\nconst box = JSON.parse('{}') as any\nbox.rec = rec\nconsole.log(box.rec.handler('x', 1))\n"
  const result = compile({ rootFileNames: [file], sourceOverlay: new Map([[file, source]]), dynamicFallback: true })
  assert.ok(result.source, JSON.stringify({ lowering: result.loweringBlockers, emission: result.emissionRefusals }))
  const binary = resolve(root, `measurements/tuple-rest-boxed-callable${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', '-O0', '-I', resolve(root, 'src/targets/cpp/runtime'), '-x', 'c++', '-', '-o', binary], {
    input: result.source + '\nint main(){__gea_top_level();}\n',
    stdio: ['pipe', 'pipe', 'inherit']
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), 'x1\n')
})
