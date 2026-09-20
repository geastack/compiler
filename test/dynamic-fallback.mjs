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
