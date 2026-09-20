// Shape and allocation budgets for the hot paths the comparison benchmarks
// price (`bench/comparison/fixtures/`). Each fixture under `test/runtime/`
// pins ONE emitted shape that a regression would silently undo, plus the
// runtime counters that shape controls, and checks the native program still
// prints what node prints. The benchmark numbers are taken on the bench box;
// this is the check that runs on every build.
import { executableSuffix } from './executable-suffix.mjs'
import { sanitizerArguments, sanitizerEnvironment } from './sanitizer.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'measurements/cxx')
mkdirSync(outDir, { recursive: true })

/** Emit, compile with the allocation profile on, run, and compare against node. */
const run = (name, { source: checkSource, epilogue = '' }) => {
  const fixture = resolve(root, 'test/runtime', name + '.ts')
  const result = compile({ rootFileNames: [fixture], projectFileName: null })
  assert.ok(result.certificate, name + ': ' + JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [], name)
  assert.deepEqual(result.emissionRefusals, [], name)
  assert.doesNotMatch(result.source, /gea_cpp_value/, name + ': a typed program must not box')
  checkSource(result.source)
  const binary = resolve(outDir, `${name}-test${executableSuffix}`)
  execFileSync(
    process.env.CXX || 'clang++',
    [
      '-std=c++20',
      '-O1',
      '-fsanitize=address,undefined',
      ...sanitizerArguments,
      '-DGEA_PROFILE_ALLOCATIONS=1',
      `-I${resolve(root, 'src/targets/cpp/runtime')}`,
      '-x',
      'c++',
      '-',
      '-o',
      binary
    ],
    {
      input:
        result.source +
        `
#include <cstdio>
int main() {
  __gea_top_level();
  const auto& profile = gea::detail::allocationProfile();
  ${epilogue}
  return 0;
}
`
    }
  )
  // Windows opens a C++ program's stdout in text mode, so its `\n` arrives as
  // `\r\n` while node's does not. The comparison is about what the two
  // printed, not about how the platform terminates a line.
  const lines = (text) => text.replaceAll('\r\n', '\n')
  const expected = lines(execFileSync(process.execPath, [fixture], { encoding: 'utf8' }))
  const actual = lines(execFileSync(binary, { encoding: 'utf8', env: sanitizerEnvironment() }))
  assert.equal(actual, expected, name + ': native output differs from node')
  console.log(name + ': ok')
}

/** A counter that must stay under `limit`; the message names the counter. */
const budget = (counter, limit) =>
  `if (profile.${counter} > ${limit}ull) { std::fprintf(stderr, "${counter} = %llu, budget ${limit}\\n", (unsigned long long)profile.${counter}); return 2; }`

// One closure per iteration, and not one identity object more. The bound is
// generous (two objects per iteration against the one the closure needs) so
// the array's growth and the sixteen seeds fit; minting identities added two
// objects per closure COPY, several copies per iteration.
run('hot-path-closure-table', {
  source: (source) => {
    assert.doesNotMatch(source, /identifyCallable/, 'no closure identity is observed, none may be minted')
    // Nothing here freezes or redefines anything, so the table's stores carry
    // no writability guard (`ir/integrity-restrictions.ts`).
    assert.doesNotMatch(
      source,
      /nativeOwnFieldsWritable|nativeIsExtensible/,
      'no integrity operation exists, no store may guard against one'
    )
    // `fns[slot] = makeKind(...)`: the call's result is move-assigned straight
    // from its return slot into the element, never through a temporary of its
    // own (`ir/deferral.ts`'s forwarded producers).
    assert.match(source, /\.value = \(gea_body_fn_decl_\w+\(/, 'the table store must take the factory call directly')
    // `const f = fns[...]; f(i)`: the cell is gone and the call runs on the
    // element in place -- no `CallableObject` copy per iteration.
    assert.match(source, /->elementAtIndex\([^;]*\)\)\)\.call\(/, 'the callee must be the table element itself, not a copy')
    assert.doesNotMatch(
      source,
      /^b\d+ = \(\(GEA_LIKELY\(gea_dense_ok_\d+\) \? gea_dense_\d+\[[^\n]*\]\.value : \w+->elementAtIndex/m,
      'no element may be copied into a cell'
    )
    // Every factory returns its callable from the return statement itself.
    assert.match(
      source,
      /return \(gea::CallableObject<double\(double\)>\{/,
      'a factory must return the callable it builds, not a named copy'
    )
  },
  epilogue: budget('created', 2 * 20000 + 64)
})

run('hot-path-closure-identity', {
  source: (source) => assert.match(source, /identifyCallable</, 'identity is observed through === and a Set; closures must carry one')
})

run('hot-path-string-append', {
  source: (source) => {
    assert.match(source, /\w+ \+= 'a';/, 'the accumulator must append in place')
    assert.doesNotMatch(source, /(\w+) = gea::concatStrings\(\{\1,/, 'string += must not rebuild the accumulator')
  }
})

// This program DOES freeze, so every native store keeps its guard -- the
// census must see `Object.freeze` and say so.
run('hot-path-integrity-fast-path', {
  source: (source) => assert.match(source, /nativeOwnFieldsWritable/, 'Object.freeze is present; the stores must keep their guards')
})

// `sum` is the only body taking exactly one nullable handle and returning a
// number; its formal must be a const reference. A borrowed walk never touches
// the count, so the collector sees no candidates from it. The bound leaves
// room for the handful `build` produces while moving handles into fields.
run('hot-path-static-layout', {
  source: (source) => {
    const struct = /struct (gea_class_decl_\w+) final \{\n([\s\S]*?)\n\};/.exec(source)
    assert.ok(struct, 'the class struct is emitted final')
    const body = struct[2]
    assert.match(
      body,
      /^  static inline gea::Ref<gea::NativeClassMethodState> gea_method_state;$/m,
      'a once-evaluated root class holds its state statically'
    )
    assert.match(body, /^  static inline bool gea_present_value = true;$/m, 'presence is a program-wide constant')
    assert.match(body, /^  static inline gea::NativeIndexAttributes gea_attributes_value;$/m, 'attributes are a program-wide constant')
    assert.doesNotMatch(body, /virtual/, 'a leaf root class has no vptr')
    assert.doesNotMatch(source, /->gea_present_\w+ = true;/, 'no store re-sets a constant presence bit')
    assert.doesNotMatch(
      source,
      /nativeClassMethodStateFromEnvironment\(\w+\.environment\)/,
      'a construct passes the state as a pointer, not a retained handle'
    )
  }
})

run('hot-path-layout-guards', {
  source: (source) => {
    assert.match(
      source,
      /^  gea::Ref<gea::NativeClassMethodState> gea_method_state;$/m,
      'a class evaluated per call keeps its state per instance'
    )
    assert.match(source, /^  bool gea_present_x = true;$/m, 'a program that deletes a field keeps presence per instance')
    assert.doesNotMatch(source, /static inline bool gea_present_/, 'no struct claims a constant presence bit while `delete` exists')
  }
})

run('hot-path-integer-ring', {
  source: (source) => {
    assert.match(
      source,
      /struct gea_record_\w+ final \{\n  long long x;\n  long long y;\n  long long z;/,
      'the ring record narrows every member'
    )
    assert.doesNotMatch(source, /gea::remainder\(/, 'the loop stays in the integers')
  }
})

run('hot-path-borrowed-tree', {
  source: (source) => {
    assert.match(
      source,
      /^double gea_body_fn_decl_\w+\(const gea::Ref<gea_class_decl_\w+>& gea_arg_0\) \{$/m,
      'sum(node) must borrow its handle'
    )
    assert.doesNotMatch(source, /nativeOwnFieldsWritable|nativeIsExtensible/, 'the constructor stores three fields with no guard')
  },
  epilogue: budget('candidates', 64)
})
