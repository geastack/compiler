import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const entry = resolve(root, 'test/runtime/native-field-metadata.ts')
const result = compile({ rootFileNames: [entry], projectFileName: null, dynamicFallback: false })
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
assert.ok(result.source.includes('NativeStringFieldMetadata<'))
assert.ok(result.source.includes('appendNativeStringFieldKeys(*this,'))
assert.ok(result.source.includes('appendNativeEnumerableStringFieldKeys(*this,'))
const executable = resolve(output, 'native-field-metadata')
execFileSync(
  'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-',
    '-o',
    executable
  ],
  {
    input: `${result.source}
struct LegacyNativeAdapter {
  double value = 7;
  bool gea_readOwnField(const gea::PropertyKey& key, gea::Value& out) const {
    if (key.isSymbol() || key.text() != "value") return false;
    out = gea::Value::box(gea::Value::Tag::Number, value);
    return true;
  }
  bool gea_writeOwnField(const gea::PropertyKey&, const gea::Value&, bool) { return false; }
  bool gea_ownFieldDescriptor(const gea::PropertyKey& key, gea::PropertyDescriptor& out) const {
    gea::Value value;
    if (!gea_readOwnField(key, value)) return false;
    out = gea::PropertyDescriptor::assignment(value);
    out.configurable = false;
    return true;
  }
  void gea_ownFieldKeys(std::vector<gea::PropertyKey>& out) const { out.push_back(gea::PropertyKey::string("value")); }
};
int main() {
  __gea_top_level();
  auto legacy = gea::Value::box(gea::Value::Tag::Object, gea::makeRef<LegacyNativeAdapter>());
  if (legacy.deleteProperty(gea::PropertyKey::string("value"))) return 1;
  if (!legacy.deleteProperty(gea::PropertyKey::string("missing"))) return 2;
}
`,
    env: { ...process.env, TMPDIR: output }
  }
)
const native = execFileSync(executable, { encoding: 'utf8' })
const js = ts.transpileModule(readFileSync(entry, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const reference = execFileSync(process.execPath, ['--input-type=module'], { input: js, encoding: 'utf8' })
assert.equal(native, reference, 'Compact metadata must preserve inheritance, descriptors, deletion/recreation, numeric order and accessors')
console.log('PASS compact native field metadata matches Node under ASan/UBSan')
