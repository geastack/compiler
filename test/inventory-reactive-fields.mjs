// Compile a compiler-owned fixture; no demo build or generated demo artifact is required.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { compile } from '../dist/compiler.js'
import { nativeOptimization } from '../scripts/native-optimization.mjs'
import { nativeHostIncludes } from '../scripts/native-host-includes.mjs'
const root = path.resolve(import.meta.dirname, '..')
const fixture = path.join(root, 'test/runtime/jsx-inventory-reactive-fields.tsx')
const result = compile({
  rootFileNames: [fixture],
  projectFileName: path.join(root, 'test/runtime/jsx-inventory-reactive-fields.tsconfig.json')
})
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
const cpp = result.source
const found = /struct (gea_record_type_\d+) final \{[^}]*gea::embedded::ui::Signal<std::string> slot;/.exec(cpp)
assert(found, 'Rendered item fields must retain typed reactive cells')
const start = found.index,
  brace = cpp.indexOf('{', start)
let depth = 1,
  index = brace + 1,
  quoted = false,
  escaped = false
for (; depth && index < cpp.length; index++) {
  const c = cpp[index]
  if (quoted) {
    if (escaped) escaped = false
    else if (c === '\\') escaped = true
    else if (c === '"') quoted = false
  } else if (c === '"') quoted = true
  else if (c === '{') depth++
  else if (c === '}') depth--
}
const declaration = cpp.slice(start, index) + ';'
assert(/array::reduce\([^;\n]*static_cast<double>\(\(0\)\)\)/.test(cpp), 'Numeric reducer seeds must use the sealed double carrier')
const runtime = fs.readFileSync(root + '/src/targets/cpp/runtime/gea_runtime.h', 'utf8')
const helperStart = runtime.indexOf('template <typename Owner>\ngea::Ref<Owner> nativeSignalOwner')
const helperEnd = runtime.indexOf('template <typename Node, typename Thunk>\nstd::function<void()> reactiveLeafTextApply', helperStart)
assert(helperStart >= 0 && helperEnd > helperStart)
const helpers = runtime.slice(helperStart, helperEnd)
const code = `#include "gea_runtime.h"\n#include "ui/signal.h"\n#include <cassert>\nstruct ${found[1]};\nnamespace gea::detail {template<>struct NativeViewTarget<::${found[1]}> : std::true_type {}; }\n${declaration}\nnamespace gea::jsx {${helpers}}\nint main(){\n auto weights=gea::arrayOf<double>({2.4,0.2}); auto sum=[](double a,double b){return a+b;};\n assert(std::abs(gea::runtime::array::reduce(weights,sum,static_cast<double>(0))-2.6)<0.000001);\n assert(std::abs(gea::runtime::array::reduceRight(weights,sum,static_cast<double>(0))-2.6)<0.000001);\n ${found[1]} item;item.slot="Neural";int changes=0;item.slot.subscribe([&](){changes++;});\n std::optional<std::string> read;gea::NativeFieldRead protocol(read);\n assert(item.gea_readOwnFieldNative(gea::PropertyKey::string("slot"),protocol));assert(read=="Neural");\n std::string value="Optics";gea::NativeFieldWrite write(value);\n assert(item.gea_writeOwnFieldNative(gea::PropertyKey::string("slot"),write));assert(item.slot.get()=="Optics");assert(changes==1);\n std::optional<double> wrong;gea::NativeFieldRead bad(wrong);assert(!item.gea_readOwnFieldNative(gea::PropertyKey::string("slot"),bad));
 double incompatible=9;gea::NativeFieldWrite badWrite(incompatible);
 assert(!item.gea_writeOwnFieldNative(gea::PropertyKey::string("slot"),badWrite));assert(item.slot.get()=="Optics");assert(changes==1);
 auto owner=gea::makeRef<${found[1]}>();owner->slot="Origin";
 auto view=gea::record::makeLiveViewWithOrigin<${found[1]}>(owner,
  +[](const gea::Ref<void>& origin,const gea::PropertyKey& key,const gea::NativeFieldRead& read){auto receiver=origin.staticCast<${found[1]}>();return receiver->gea_readOwnFieldNative(key,const_cast<gea::NativeFieldRead&>(read));},
  +[](const gea::Ref<void>& origin,const gea::PropertyKey& key,const gea::NativeFieldWrite& write){return origin.staticCast<${found[1]}>()->gea_writeOwnFieldNative(key,write);});
 auto reader=gea::jsx::signalReader(view,&${found[1]}::slot);
 assert(reader.call()=="Origin");assert(reader.owner==owner);
 owner->slot="Updated";assert(reader.call()=="Updated");
}`
const binary = root + '/dist/inventory-reactive-fields-test'
execFileSync(
  'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-I' + root + '/src/targets/cpp/runtime',
    ...nativeHostIncludes,
    '-x',
    'c++',
    '-',
    '-o',
    binary
  ],
  { input: code, stdio: ['pipe', 'pipe', 'pipe'] }
)
execFileSync(binary)
console.log(
  'PASS: compiled reactive item protocol exposes typed values, notifies writes, rejects incompatible payloads, and follows live-view origin cells'
)
