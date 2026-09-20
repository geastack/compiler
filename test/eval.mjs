import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const binary = resolve(root, `measurements/eval-runtime${executableSuffix}`)
execFileSync(
  'clang++',
  [
    '-std=c++20',
    '-O0',
    '-g',
    '-fsanitize=address,undefined',
    '-I',
    resolve(root, 'src/targets/cpp/runtime'),
    resolve(root, 'test/runtime/eval-runtime.cpp'),
    '-o',
    binary
  ],
  { stdio: 'inherit' }
)
const cases = [
  'throw 7;',
  'throw "failure";',
  'throw null;',
  'throw undefined;',
  'let f=function named(){named=3; return typeof named;}; return f();',
  'let f=function named(){"use strict"; named=3;}; return f();',
  'let f=function(){}; return f.name;',
  'let f=function(){}; return f.prototype.constructor===f;',
  'let x=function named(){}; return x.name;',
  'return (function(){}).name;',
  '\"use strict\" + \"\"; leaked=3; return leaked;',
  '("other"); "use strict"; leaked=3; return leaked;',

  'return 1 + 2 * 3;',
  'return (1 + 2) * 3;',
  'let n=0; false && n++; true || n++; return n;',
  'let n=0; if(false) return n++; return n;',
  'let n=0; let x=true ? ++n : ++n; return n + ":" + x;',
  'let n=0; null ?? n++; 0 ?? n++; return n;',
  'let n=0; let f=function(){n++; return n;}; return f() + f();',
  'let n=0; let f=function(){n++; return n;}; return false && f();',
  'let n=0; let a=[1]; let f=function(){n++; return 0;}; a[f()] += 2; return n + ":" + a[0];',
  'let x="2"; let y=x++; return typeof y + ":" + y + ":" + x;',
  'let a=1; return a++ + ++a;',
  'return "12" < "2";',
  'return "12" < 2;',
  'return 1 == "1";',
  'return false == "0";',
  'return null == undefined;',
  'return null == 0;',
  'return NaN === NaN;',
  'return 0 === -0;',
  'let a={}; return a === a;',
  'return {} === {};',
  'return 4294967295 >> 0;',
  'return -1 >>> 0;',
  'return 2147483648 >> 1;',
  'return 1 << 33;',
  'return 1 << -1;',
  'return Infinity | 0;',
  'return -5 % 2;',
  'return 1 / -0;',
  'return 31 - Math.clz32(4);',
  'return "hé😀".length;',
  'return "hé😀".charCodeAt(2);',
  'return "hé😀".charCodeAt(3);',
  'return "hello".slice(-2);',
  'return "hello".substring(4, 1);',
  'return "\\uD83D\\uDE00".length;',
  'return "😀" < "\uE000";',
  'return "a\\x62\\u0063";',
  'let a=[,2,,]; return a.length + ":" + (0 in a) + ":" + (1 in a);',
  'let x=1; {let x=2;} return x;',
  'return x; var x=2;',
  'return typeof absent;',
  'return absent;',
  'return typeof x; let x=2;',
  'let x=1; { return x; let x=2; }',
  'const x=1; x=2; return x;',
  'let x=1; let x=2;',
  'let x=1; { var x=2; }',
  'let n=0; for(let i=0;i<5;i++){if(i===2) continue; n+=i;} return n;',
  'let n=0; while(n<10){ n++; if(n===3) break; } return n;',
  'let f=[]; for(let i=0;i<3;i++){ f[i]=function(){return i;}; } return f[0]()+f[1]()+f[2]();',
  'let f=function(n){return function(){return ++n;};}; let g=f(2); return g()+g();',
  'let f=function fact(n){return n<2?1:n*fact(n-1);}; return f(5);',
  'let obj={x:7,f:function(a){return this.x+a;}}; return obj.f(2);',
  'let obj={x:7,f:function(){return this.x;}}; return (obj.f)();',
  'let f=function(){"use strict"; return this;}; return f();',
  'let f=function(){return this;}; return f()===globalThis;',
  'let f=function(a){return this.x+a;}; return f.call({x:3},4);',
  'let f=function(a,b){return this.x+a+b;}; return f.apply({x:3},[4,5]);',
  'let f=function(a,b){return this.x+a+b;}; let g=f.bind({x:3},4); return g(5);',
  'let C=function(x){this.x=x;}; let a=new C(7); return a.x;',
  'let C=function(){return {x:8};}; return new C().x;',
  'let C=function(){return 3;}; return typeof new C();',
  'let x=1; let f=function(){x=2; return 0;}; let a=[10]; a[f()] += x; return a[0];',
  'let n=0; let f=function(){n++;}; if(false){f();} else {n=4;} return n;',
  'return\n3;',
  'let x=1\nx++\nreturn x;',
  'return /* comment\n */ 3;',
  'return "if";',
  '"use strict"; undeclared=3;',
  '"use strict"; return this;',
  'let o={x:1}; delete o.x; return "x" in o;',
  'return (1,2,3);',
  'let x=0; return (x=2,x+3);',
  'return 0 ?? 1 || 2;',
  'return 0 ?? (1 || 2);',
  'return true ? 2 : 3 ? 4 : 5;',
  'let f=function(){return 4;}; false && f(); return 8;',
  'let o={valueOf:function(){return 3;}}; return o+1;',
  'let o={toString:function(){return "x";}}; return String(o);',
  'let o={}; return o+"!";',
  'let f=function(){return 3;}; return f.length;',
  'let f=function(){return 3;}; return f(1,2);'
]
for (const body of cases)
  test(`Eval matches Node: ${body}`, () => {
    const actual = execFileSync(binary, [body], { encoding: 'utf8' })
    const expected = execFileSync(
      process.execPath,
      [
        '-e',
        `try { const r = new Function(${JSON.stringify(body)})(); console.log(typeof r + ':' + String(r)); } catch(e) {console.log(e instanceof Error ? 'throw:' + e.name : 'throw-value:' + typeof e + ':' + String(e))}`
      ],
      { encoding: 'utf8' }
    )
    assert.equal(actual, expected)
  })
for (const source of ['1; if(false) 2;', '1; {}', '1; while(false) 2;', 'let x=2; x+1;'])
  test(`Script completion: ${source}`, () => {
    const actual = execFileSync(binary, [source, 'script'], { encoding: 'utf8' })
    const expected = execFileSync(
      process.execPath,
      ['-e', `const r=(0,eval)(${JSON.stringify(source)}); console.log(typeof r+':'+String(r))`],
      { encoding: 'utf8' }
    )
    assert.equal(actual, expected)
  })
for (const body of [
  'if(false){class C{}} return 1;',
  'return function(a=1){return a;};',
  'return eval("2");',
  'return `template`;',
  'return new Number(2);'
]) {
  test(`Unsupported forms refuse explicitly: ${body}`, () =>
    assert.match(execFileSync(binary, [body], { encoding: 'utf8' }), /^throw:EvalUnsupportedError/))
}
for (const form of ['new Function', 'Function'])
  test(`compiler routes ${form} through the opt-in runtime`, () => {
    const file = resolve(root, 'test/runtime/eval-source.js')
    const source = `const f=${form}('a','b','return a+b'); console.log(f(2,3),f.call(null,4,5),f.length,f.name);`
    const request = { rootFileNames: [file], sourceOverlay: new Map([[file, source]]), javaScriptSources: true }
    assert.equal(compile(request).source, null)
    const result = compile({ ...request, dynamicFallback: true })
    assert.ok(
      result.source,
      JSON.stringify({ diagnostics: result.diagnostics, lowering: result.loweringBlockers, emission: result.emissionRefusals })
    )
    assert.match(result.source, /Eval::functionArgument\(/)
    assert.doesNotMatch(result.source, /Eval::constructFunction\(\{gea::Value::box/)
    const executable = resolve(root, `measurements/eval-source${executableSuffix}`)
    execFileSync('clang++', ['-std=c++20', '-O0', '-I', resolve(root, 'src/targets/cpp/runtime'), '-x', 'c++', '-', '-o', executable], {
      input: result.source + '\nint main(){__gea_top_level();}\n',
      stdio: ['pipe', 'pipe', 'inherit']
    })
    assert.equal(execFileSync(executable, { encoding: 'utf8' }), '5 9 2 anonymous\n')
  })

test('Eval runtime boundaries, early errors, coercion hints, and closure lifetime', () => {
  const executable = resolve(root, `measurements/eval-boundaries${executableSuffix}`)
  execFileSync(
    'clang++',
    [
      '-std=c++20',
      '-O0',
      '-g',
      '-fsanitize=address,undefined',
      '-I',
      resolve(root, 'src/targets/cpp/runtime'),
      resolve(root, 'test/runtime/eval-boundaries.cpp'),
      '-o',
      executable
    ],
    { stdio: 'inherit' }
  )
  execFileSync(executable, { stdio: 'inherit' })
})

test('opt-in variadic tuple carrier preserves indexed values and array length', () => {
  const file = resolve(root, 'test/runtime/eval-variadic.ts')
  const source = "type Args = [number, ...string[]]; const a: Args=[7,'a']; console.log(a[0],a.length);"
  const result = compile({ rootFileNames: [file], sourceOverlay: new Map([[file, source]]), dynamicFallback: true })
  assert.ok(result.source, JSON.stringify(result.diagnostics))
  const executable = resolve(root, `measurements/eval-variadic${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', '-O0', '-I', resolve(root, 'src/targets/cpp/runtime'), '-x', 'c++', '-', '-o', executable], {
    input: result.source + '\nint main(){__gea_top_level();}\n',
    stdio: ['pipe', 'pipe', 'inherit']
  })
  assert.equal(execFileSync(executable, { encoding: 'utf8' }), '7 2\n')
})
