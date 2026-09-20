import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import test from 'node:test'
import type { SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { CallOperation, IrOperand } from '../ir/model.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import type { EmitContext } from '../targets/cpp/emit-context.js'
import { cppRecordDeclarations } from '../targets/cpp/records.js'
import { cppRecordStructName, cppTypeOf } from '../targets/cpp/types.js'
import { createRepresentationDeriver } from './derive.js'
import type { Representation } from './model.js'
import type { SealedRepresentationPlan } from './plan.js'
import { verifyRepresentationPlan } from './verify.js'

// Windows' CreateProcess appends `.exe` to a name that has none, so a binary
// linked without an extension cannot be spawned at all.
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const result = (name: string): SemanticResultId => name as SemanticResultId

const planOf = (representation: Representation): SealedRepresentationPlan => ({
  selected: new Map([[result('multiple-index-record'), representation]]),
  evidence: new Map(),
  conflicts: []
})

const emptyReactivePlan = {
  fields: new Map(),
  cell: null,
  cellPreamble: [],
  dependencies: new Map(),
  nodeDependencies: new Map(),
  revisions: new Map(),
  celled: new Map(),
  boundRecordFields: new Map()
}

const multiIndexShape = (value: StructuralTypeId, symbolValue: StructuralTypeId = value) => ({
  kind: 'object' as const,
  members: [
    {
      key: { kind: 'string' as const, value: 'fixed' },
      type: value,
      optional: false,
      readonly: false,
      accessor: null
    }
  ],
  index: [
    { key: 'string' as const, value, readonly: false },
    { key: 'number' as const, value, readonly: false },
    { key: 'symbol' as const, value: symbolValue, readonly: false }
  ],
  membersDropped: false
})

/**
 * `test/sanitizer.mjs` states this rule for the build's own sanitized steps;
 * it cannot be imported from here, because it lives outside this program's
 * root. MSVC's STL asks the linker for `stl_asan.lib` whenever it is compiled
 * under AddressSanitizer, and that library ships with Visual Studio's optional
 * C++ AddressSanitizer component rather than with clang -- so where it is
 * absent the link fails before this test runs at all. Disabling the
 * `std::string`/`std::vector` container annotations, and only those, lets it
 * run; heap, stack and UB checking are unaffected.
 */
const directoriesUnder = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}
const msvcStlAsanIsInstalled = (): boolean => {
  for (const root of [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].filter((value): value is string => !!value))
    for (const edition of directoriesUnder(join(root, 'Microsoft Visual Studio')))
      for (const product of directoriesUnder(edition))
        for (const toolset of directoriesUnder(join(product, 'VC', 'Tools', 'MSVC')))
          if (existsSync(join(toolset, 'lib', 'x64', 'stl_asan.lib'))) return true
  return false
}
const clangRuntimeDirectory = (): string | null => {
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter((value): value is string => !!value))
    for (const version of directoriesUnder(join(root, 'LLVM', 'lib', 'clang'))) {
      const windows = join(version, 'lib', 'windows')
      if (existsSync(join(windows, 'clang_rt.asan_dynamic-x86_64.dll'))) return windows
    }
  return null
}
const sanitizerArguments = process.platform === 'win32' && !msvcStlAsanIsInstalled() ? ['-D_DISABLE_STL_ANNOTATION'] : []
const sanitizerPath = (): string => {
  const runtime = process.platform === 'win32' ? clangRuntimeDirectory() : null
  return runtime ? `${process.env['PATH'] ?? ''}${delimiter}${runtime}` : (process.env['PATH'] ?? '')
}

test('compatible string+number indexes canonicalize while symbols retain identity storage', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const shape = table.intern(multiIndexShape(string))
  const deriver = createRepresentationDeriver(table.seal())
  const carrier = deriver.derive(shape)

  assert.equal(carrier.kind, 'record-with-index')
  assert.deepEqual(
    carrier.indexes.map((index) => index.key),
    ['string', 'symbol']
  )
  assert.ok(carrier.indexes.every((index) => index.value.kind === 'string'))
  assert.deepEqual(verifyRepresentationPlan(planOf(carrier)), [])

  const rendered = cppRecordDeclarations(planOf(carrier), deriver, new Map(), emptyReactivePlan, new Map())
  assert.deepEqual(rendered.refused, [])
  const declarations = rendered.declarations.join('\n')
  assert.match(declarations, /gea::Dictionary<std::string> gea_dynamic;/)
  assert.match(declarations, /gea::SymbolDictionary<std::string> gea_symbol_dynamic;/)
  assert.match(declarations, /std::string fixed;/)
  assert.doesNotMatch(declarations, /Dictionary<gea::Value>|SymbolDictionary<gea::Value>/)
  assert.match(
    declarations,
    /gea_writeOwnFieldNative\(gea_key, gea::NativeFieldWrite\(gea_value\), gea_extensible\)/,
    'fixed fields addressed through a native index must retain native transport'
  )
  assert.match(declarations, /gea_value\.assign\(fixed\)/)

  const compiler = process.env.CXX ?? 'clang++'
  const executable = resolve(import.meta.dirname, `../../node_modules/.bin/gea-multiple-index-signatures-test${executableSuffix}`)
  const struct = cppRecordStructName(shape)
  const source = `
#include "gea_runtime.h"
${declarations}
int main() {
  ${struct} value{};
  const gea::Symbol first = gea::makeSymbol("same");
  const gea::Symbol second = gea::makeSymbol("same");
  if (!value.gea_writeOwnIndexNative(gea::PropertyKey::number(7), std::string("seven"))) return 1;
  if (!value.gea_writeOwnIndexNative(gea::PropertyKey::symbol(first), std::string("first"))) return 2;
  if (!value.gea_writeOwnIndexNative(gea::PropertyKey::symbol(second), std::string("second"))) return 3;
  if (value.gea_dynamic.read("7") != "seven") return 4;
  if (value.gea_symbol_dynamic.read(first) != "first") return 5;
  if (value.gea_symbol_dynamic.read(second) != "second") return 6;
  if (first == second) return 7;
  gea::Value reflected;
  if (!value.gea_readOwnIndex(gea::PropertyKey::number(7), reflected)) return 8;
  if (!value.gea_readOwnIndex(gea::PropertyKey::symbol(first), reflected)) return 9;

  auto shared = gea::makeRef<${struct}>();
  shared->fixed = "initial";
  if (!shared->gea_writeOwnIndexNative(gea::PropertyKey::string("fixed"), std::string("computed"))) return 10;
  if (shared->fixed != "computed" || shared->gea_dynamic.has("fixed")) return 11;
  if (!gea::nativeDynamicSet(shared, gea::PropertyKey::string("fixed"), gea::Value::box(gea::Value::Tag::String, std::string("set")))) return 12;
  if (shared->fixed != "set" || shared->gea_dynamic.has("fixed")) return 13;

  gea::PropertyDescriptor descriptor = gea::PropertyDescriptor::assignment(
      gea::Value::box(gea::Value::Tag::String, std::string("defined")));
  descriptor.writable = false;
  descriptor.enumerable = false;
  descriptor.configurable = true;
  if (!gea::nativeDynamicDefineProperty(shared, gea::PropertyKey::string("fixed"), descriptor)) return 14;
  if (shared->fixed != "defined" || shared->gea_dynamic.has("fixed")) return 15;
  const auto fixedDescriptor = gea::nativeOwnPropertyDescriptor(shared, gea::PropertyKey::string("fixed"));
  if (!fixedDescriptor.has_value() || fixedDescriptor->writable || fixedDescriptor->enumerable || !fixedDescriptor->configurable) return 16;
  if (gea::nativeDynamicSet(shared, gea::PropertyKey::string("fixed"), gea::Value::box(gea::Value::Tag::String, std::string("wrong")))) return 17;
  if (!gea::nativeDynamicDelete(shared, gea::PropertyKey::string("fixed"))) return 18;
  if (shared->gea_present_fixed || shared->gea_dynamic.has("fixed")) return 19;
  if (gea::nativeDynamicHas(shared, gea::PropertyKey::string("fixed"))) return 20;
  if (gea::nativeDynamicGet(shared, gea::PropertyKey::string("fixed")).tag() != gea::Value::Tag::Undefined) return 21;
  descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
  if (!gea::nativeDynamicDefineProperty(shared, gea::PropertyKey::string("fixed"), descriptor)) return 22;
  if (!shared->gea_present_fixed || shared->fixed != "defined" || shared->gea_dynamic.has("fixed")) return 23;

  if (!gea::nativeDynamicSet(shared, gea::PropertyKey::symbol(first), gea::Value::box(gea::Value::Tag::String, std::string("reflect-symbol")))) return 24;
  if (!gea::nativeDynamicHasProperty(shared, gea::PropertyKey::symbol(first))) return 25;
  if (gea::nativeDynamicGet(shared, gea::PropertyKey::symbol(first)).as<std::string>() != "reflect-symbol") return 26;
  const auto symbolDescriptor = gea::nativeOwnPropertyDescriptor(shared, gea::PropertyKey::symbol(first));
  if (!symbolDescriptor.has_value() || !symbolDescriptor->writable || !symbolDescriptor->enumerable || !symbolDescriptor->configurable) return 27;
  if (!gea::nativeDynamicDelete(shared, gea::PropertyKey::symbol(first))) return 28;
  if (gea::nativeDynamicHas(shared, gea::PropertyKey::symbol(first))) return 29;
  double nativeTarget = 1.0;
  using NullOptionalPolicy = gea::NativeFieldOptionalPolicy<true>;
  using UndefinedOptionalPolicy = gea::NativeFieldOptionalPolicy<false>;
  using NullUnionPolicy = gea::NativeFieldUnionPolicy<NullOptionalPolicy, gea::NativeFieldLeafPolicy>;
  using UndefinedUnionPolicy = gea::NativeFieldUnionPolicy<UndefinedOptionalPolicy, gea::NativeFieldLeafPolicy>;
  const gea::Optional<double> presentNative(2.5);
  if (!gea::NativeFieldWrite(presentNative, NullOptionalPolicy{}).assign(nativeTarget) || nativeTarget != 2.5) return 30;
  const gea::Optional<double> absentNative;
  if (gea::NativeFieldWrite(absentNative, UndefinedOptionalPolicy{}).assign(nativeTarget)) return 31;
  gea::Optional<double> targetOptional(4.0);
  if (gea::NativeFieldWrite(absentNative, NullOptionalPolicy{}).assign(targetOptional) || !targetOptional.has_value()) return 35;
  if (!gea::NativeFieldWrite(absentNative, NullOptionalPolicy{}).assign<NullOptionalPolicy>(targetOptional) || targetOptional.has_value()) return 36;
  if (gea::NativeFieldWrite(gea::Undefined{}).assign<NullOptionalPolicy>(targetOptional)) return 37;
  if (gea::NativeFieldWrite(absentNative).assign(targetOptional)) return 44;
  // Pre-aligned reflection transport retains its original exact-type contract.
  if (!gea::NativeFieldWrite::exact(absentNative).assign<NullOptionalPolicy>(targetOptional)) return 38;
  using NestedValue = gea::TaggedUnion<double, std::string>;
  using NestedOptional = gea::Optional<NestedValue>;
  using NullNestedOptionalPolicy = gea::NativeFieldOptionalPolicy<true,
      gea::NativeFieldUnionPolicy<gea::NativeFieldLeafPolicy, gea::NativeFieldLeafPolicy>>;
  using UndefinedNestedOptionalPolicy = gea::NativeFieldOptionalPolicy<false,
      gea::NativeFieldUnionPolicy<gea::NativeFieldLeafPolicy, gea::NativeFieldLeafPolicy>>;
  const NestedOptional absentNested;
  NestedOptional nullNestedTarget(NestedValue::ofArm<0>(1.0));
  if (!gea::NativeFieldWrite(absentNested, NullNestedOptionalPolicy{}).assign<NullNestedOptionalPolicy>(nullNestedTarget) ||
      nullNestedTarget.has_value()) return 40;
  if (gea::NativeFieldWrite(absentNested, NullNestedOptionalPolicy{}).assign<UndefinedNestedOptionalPolicy>(nullNestedTarget)) return 41;
  const std::nullptr_t nullValue = nullptr;
  using TwoAbsences = gea::Optional<gea::Optional<double>>;
  using TwoAbsencesPolicy = gea::NativeFieldOptionalPolicy<false, NullOptionalPolicy>;
  TwoAbsences nestedInnerNull;
  if (!gea::NativeFieldWrite(nullValue).assign<TwoAbsencesPolicy>(nestedInnerNull) ||
      !nestedInnerNull.has_value() || nestedInnerNull->has_value()) return 45;
  using NullableUnion = gea::TaggedUnion<std::nullptr_t, double>;
  using NullableUnionPolicy = gea::NativeFieldUnionPolicy<gea::NativeFieldLeafPolicy, gea::NativeFieldLeafPolicy>;
  using OptionalNullableUnion = gea::Optional<NullableUnion>;
  using UndefinedOptionalNullableUnionPolicy = gea::NativeFieldOptionalPolicy<false, NullableUnionPolicy>;
  OptionalNullableUnion optionalNullableUnion;
  if (!gea::NativeFieldWrite(nullValue).assign<UndefinedOptionalNullableUnionPolicy>(optionalNullableUnion) ||
      !optionalNullableUnion.has_value() || !optionalNullableUnion->is<0>()) return 46;
  using OptionalUnion = gea::TaggedUnion<gea::Optional<double>, std::string>;
  const OptionalUnion nestedNullArm = OptionalUnion::ofArm<0>(gea::Optional<double>{});
  OptionalUnion nestedUnionTarget = OptionalUnion::ofArm<1>(std::string("kept"));
  if (!gea::NativeFieldWrite(nestedNullArm, NullUnionPolicy{}).assign<NullUnionPolicy>(nestedUnionTarget) ||
      !nestedUnionTarget.is<0>() || nestedUnionTarget.get<0>().has_value()) return 42;
  if (gea::NativeFieldWrite(nestedNullArm, NullUnionPolicy{}).assign<UndefinedUnionPolicy>(nestedUnionTarget)) return 43;
  using FlatNullableUnion = gea::TaggedUnion<std::nullptr_t, double, std::string>;
  using FlatNullableUnionPolicy = gea::NativeFieldUnionPolicy<gea::NativeFieldLeafPolicy,
      gea::NativeFieldLeafPolicy, gea::NativeFieldLeafPolicy>;
  FlatNullableUnion flatTarget = FlatNullableUnion::ofArm<1>(3.0);
  if (!gea::NativeFieldWrite(nestedNullArm, NullUnionPolicy{}).assign<FlatNullableUnionPolicy>(flatTarget) ||
      !flatTarget.is<0>()) return 47;
  struct NonDefault { explicit NonDefault(int n) : value(n) {} int value; };
  using WithNonDefault = gea::TaggedUnion<double, NonDefault>;
  auto nonDefaultTarget = WithNonDefault::ofArm<0>(1.0);
  const NonDefault nonDefaultSource(7);
  if (!gea::NativeFieldWrite(nonDefaultSource).assign(nonDefaultTarget) || !nonDefaultTarget.is<1>() || nonDefaultTarget.get<1>().value != 7) return 39;
  using MixedNative = gea::TaggedUnion<double, std::string>;
  const MixedNative numericArm = MixedNative::ofArm<0>(4.5);
  if (!gea::NativeFieldWrite(numericArm).assign(nativeTarget) || nativeTarget != 4.5) return 32;
  const MixedNative stringArm = MixedNative::ofArm<1>(std::string("wrong"));
  if (gea::NativeFieldWrite(stringArm).assign(nativeTarget)) return 33;
  gea::Optional<double> optionalTarget;
  if (!gea::NativeFieldWrite(6.5).assign(optionalTarget) || !optionalTarget.has_value() || *optionalTarget != 6.5) return 34;
  return 0;
}
`
  try {
    const compiled = spawnSync(
      compiler,
      ['-std=c++20', `-I${resolve(import.meta.dirname, '../../src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', executable],
      { input: source, encoding: 'utf8' }
    )
    const diagnostics = [compiled.stdout, compiled.stderr, compiled.error?.message].filter(Boolean).join('\n')
    assert.equal(compiled.status, 0, `${compiler} rejected the generated multi-sidecar record:\n${diagnostics}`)
    const executed = spawnSync(executable, [], { encoding: 'utf8' })
    const runtimeDiagnostics = [executed.stdout, executed.stderr, executed.error?.message].filter(Boolean).join('\n')
    assert.equal(executed.status, 0, `generated multi-sidecar record failed at runtime:\n${runtimeDiagnostics}`)
  } finally {
    try {
      unlinkSync(executable)
    } catch {}
  }
})

test('number indexes use canonical PropertyKey text without NaN ordering', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const shape = table.intern({
    kind: 'object',
    members: [],
    index: [{ key: 'number', value: string, readonly: false }],
    membersDropped: false
  })
  const deriver = createRepresentationDeriver(table.seal())
  const carrier = deriver.derive(shape)
  assert.equal(carrier.kind, 'dictionary')

  // A named field keeps the carrier in record-with-index form so the same
  // canonicalization is exercised through generated reflection hooks.
  const recordTable = createStructuralTypeTable()
  const recordString = recordTable.intern({ kind: 'primitive', primitive: 'string' })
  const recordShape = recordTable.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'fixed' }, type: recordString, optional: false, readonly: false, accessor: null }],
    index: [{ key: 'number', value: recordString, readonly: false }],
    membersDropped: false
  })
  const recordDeriver = createRepresentationDeriver(recordTable.seal())
  const recordCarrier = recordDeriver.derive(recordShape)
  assert.equal(recordCarrier.kind, 'record-with-index')
  const rendered = cppRecordDeclarations(planOf(recordCarrier), recordDeriver, new Map(), emptyReactivePlan, new Map())
  assert.deepEqual(rendered.refused, [])
  const declarations = rendered.declarations.join('\n')
  assert.match(declarations, /gea::NumericDictionary<std::string>/)
  assert.match(declarations, /NativeIndexAttributeTable<std::string>/)
  assert.doesNotMatch(declarations, /NativeIndexAttributeTable<double>/)

  const compiler = process.env.CXX ?? 'clang++'
  const executable = resolve(import.meta.dirname, `../../node_modules/.bin/gea-number-property-key-test${executableSuffix}`)
  const struct = cppRecordStructName(recordShape)
  const source = `
#include "gea_runtime.h"
#include <limits>
${declarations}
int main() {
  gea::NumericDictionary<std::string> raw;
  const double nan = std::numeric_limits<double>::quiet_NaN();
  raw[nan] = "nan";
  raw[std::numeric_limits<double>::infinity()] = "positive";
  raw[-std::numeric_limits<double>::infinity()] = "negative";
  raw[-0.0] = "minus-zero";
  if (raw.size() != 4 || raw.read("NaN") != "nan" || raw.read("Infinity") != "positive" || raw.read("-Infinity") != "negative") return 1;
  if (raw.read(0.0) != "minus-zero" || raw.read("0") != "minus-zero") return 2;

  auto value = gea::makeRef<${struct}>();
  auto set = [&](const gea::PropertyKey& key, const char* text) {
    return gea::nativeDynamicSet(value, key, gea::Value::box(gea::Value::Tag::String, std::string(text)));
  };
  if (!set(gea::PropertyKey::number(nan), "nan")) return 3;
  if (!set(gea::PropertyKey::number(std::numeric_limits<double>::infinity()), "positive")) return 4;
  if (!set(gea::PropertyKey::number(-std::numeric_limits<double>::infinity()), "negative")) return 5;
  if (!set(gea::PropertyKey::number(-0.0), "zero")) return 6;
  if (!set(gea::PropertyKey::string("Infinity"), "positive-alias")) return 7;
  if (gea::nativeDynamicGet(value, gea::PropertyKey::string("NaN")).as<std::string>() != "nan") return 7;
  if (gea::nativeDynamicGet(value, gea::PropertyKey::number(std::numeric_limits<double>::infinity())).as<std::string>() != "positive-alias") return 8;
  if (gea::nativeDynamicGet(value, gea::PropertyKey::string("-Infinity")).as<std::string>() != "negative") return 9;
  if (gea::nativeDynamicGet(value, gea::PropertyKey::string("0")).as<std::string>() != "zero") return 10;
  const auto infinityDescriptor = gea::nativeOwnPropertyDescriptor(value, gea::PropertyKey::string("Infinity"));
  if (!infinityDescriptor.has_value() || infinityDescriptor->value.as<std::string>() != "positive-alias") return 11;
  if (!set(gea::PropertyKey::number(1), "one") || !set(gea::PropertyKey::string("01"), "leading")) return 11;
  if (value->gea_matchesOwnIndex(gea::PropertyKey::string("01"))) return 12;
  if (gea::nativeDynamicGet(value, gea::PropertyKey::number(1)).as<std::string>() != "one") return 13;
  if (gea::nativeDynamicGet(value, gea::PropertyKey::string("01")).as<std::string>() != "leading") return 14;
  if (!gea::nativeDynamicDelete(value, gea::PropertyKey::string("NaN"))) return 15;
  if (gea::nativeDynamicHas(value, gea::PropertyKey::number(nan))) return 16;
  return 0;
}
`
  try {
    const compiled = spawnSync(
      compiler,
      ['-std=c++20', `-I${resolve(import.meta.dirname, '../../src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', executable],
      { input: source, encoding: 'utf8' }
    )
    const diagnostics = [compiled.stdout, compiled.stderr, compiled.error?.message].filter(Boolean).join('\n')
    assert.equal(compiled.status, 0, `${compiler} rejected canonical number-key storage:\n${diagnostics}`)
    const executed = spawnSync(executable, [], { encoding: 'utf8' })
    const runtimeDiagnostics = [executed.stdout, executed.stderr, executed.error?.message].filter(Boolean).join('\n')
    assert.equal(executed.status, 0, `canonical number-key runtime regression failed:\n${runtimeDiagnostics}`)
  } finally {
    try {
      unlinkSync(executable)
    } catch {}
  }
})

test('symbol storage may use a different native value carrier from the text domain', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const shape = table.intern(multiIndexShape(string, number))
  const deriver = createRepresentationDeriver(table.seal())
  const carrier = deriver.derive(shape)

  assert.equal(carrier.kind, 'record-with-index')
  assert.deepEqual(
    carrier.indexes.map((index) => [index.key, index.value.kind === 'scalar' ? index.value.domain : index.value.kind]),
    [
      ['string', 'string'],
      ['symbol', 'number']
    ]
  )
  const rendered = cppRecordDeclarations(planOf(carrier), deriver, new Map(), emptyReactivePlan, new Map())
  assert.deepEqual(rendered.refused, [])
  const checked = spawnSync(
    process.env.CXX ?? 'clang++',
    ['-std=c++20', '-fsyntax-only', `-I${resolve(import.meta.dirname, '../../src/targets/cpp/runtime')}`, '-x', 'c++', '-'],
    { input: `#include "gea_runtime.h"\n${rendered.declarations.join('\n')}\n`, encoding: 'utf8' }
  )
  const diagnostics = [checked.stdout, checked.stderr, checked.error?.message].filter(Boolean).join('\n')
  assert.equal(checked.status, 0, `different text/symbol value carriers produced invalid C++:\n${diagnostics}`)
})

test('overlapping string and number domains refuse incompatible native value carriers', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const shape = table.intern({
    kind: 'object',
    members: [],
    index: [
      { key: 'string', value: string, readonly: false },
      { key: 'number', value: number, readonly: false }
    ],
    membersDropped: false
  })
  const carrier = createRepresentationDeriver(table.seal()).derive(shape)

  assert.equal(carrier.kind, 'unresolved')
  assert.match(carrier.reason, /string and number index signatures have incompatible native value carriers/)
})

test('duplicate symbol domains refuse incompatible native value carriers', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const shape = table.intern({
    kind: 'object',
    members: [],
    index: [
      { key: 'symbol', value: string, readonly: false },
      { key: 'symbol', value: number, readonly: false }
    ],
    membersDropped: false
  })
  const carrier = createRepresentationDeriver(table.seal()).derive(shape)

  assert.equal(carrier.kind, 'unresolved')
  assert.match(carrier.reason, /symbol index signatures have incompatible native value carriers/)
})

test('a Fastify-style callable ABI carries all three compatible index signatures without boxing', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const undefinedValue = table.intern({ kind: 'primitive', primitive: 'undefined' })
  const descriptors = table.intern(multiIndexShape(string))
  const callable = table.intern({
    kind: 'signature',
    call: [
      {
        parameters: [{ type: descriptors, slot: descriptors, optional: false, rest: false, hasInitializer: false }],
        minimumArity: 1,
        thisParameter: null,
        result: undefinedValue
      }
    ],
    construct: []
  })
  const carrier = createRepresentationDeriver(table.seal()).derive(callable)

  assert.notEqual(carrier.kind, 'unresolved')
  assert.doesNotMatch(JSON.stringify(carrier), /"kind":"dynamic"|more than one index signature/)
  assert.deepEqual(verifyRepresentationPlan(planOf(carrier)), [])
})

test('Reflect emitter accepts runtime string, number, and symbol keys through unified native dispatch', async () => {
  // Load the normal compiler graph first; importing this leaf as an entrypoint
  // would reverse an intentional emitter cycle that the compiler itself owns.
  await import('../compiler.js')
  const { nativeReflectCallText } = await import('../targets/cpp/host/emit-host-reflect.js')
  const string: Representation = { kind: 'string' }
  const target = {
    value: 'target',
    representation: {
      kind: 'record-with-index',
      shapeId: 'reflect-shape',
      ownership: 'shared-refcount',
      fields: [{ key: 'fixed', value: string, required: true }],
      indexes: [
        { key: 'string', value: string },
        { key: 'symbol', value: string }
      ]
    }
  } as unknown as IrOperand
  const keys = {
    string: { value: 'string-key', representation: string } as unknown as IrOperand,
    number: { value: 'number-key', representation: { kind: 'scalar', domain: 'number' } } as unknown as IrOperand,
    symbol: { value: 'symbol-key', representation: { kind: 'symbol' } } as unknown as IrOperand
  }
  const written = { value: 'written', representation: string } as unknown as IrOperand
  const ctx = {
    constantTexts: new Map(),
    staticKeyTexts: new Map(),
    valueNames: new Map([
      [target.value, 'gea_target'],
      [keys.string.value, 'gea_string_key'],
      [keys.number.value, 'gea_number_key'],
      [keys.symbol.value, 'gea_symbol_key'],
      [written.value, 'gea_written']
    ]),
    hostMemberReads: new Map(),
    hostClassReads: new Map(),
    classObjectReads: new Map(),
    hostNamespaceReads: new Map(),
    hostFunctionReads: new Map(),
    prototypeMethodReads: new Map(),
    deferredTexts: new Map(),
    pendingPacks: new Map(),
    deadValues: new Set(),
    deferrable: new Set(),
    unreadValues: new Set(),
    classes: new Map()
  } as unknown as EmitContext
  const emit = (spelling: string, key: IrOperand): string => {
    const set = spelling === 'gea::reflectSet'
    const operation = {
      kind: 'call',
      callee: written,
      receiver: null,
      arguments: set ? [target, key, written] : [target, key],
      result: { id: 'reflect-result', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
    } as unknown as CallOperation
    return nativeReflectCallText(ctx, operation, spelling) ?? ''
  }

  assert.match(emit('gea::reflectGet', keys.string), /nativeDynamicGet/)
  assert.match(emit('gea::reflectSet', keys.number), /nativeDynamicSet[^\n]*PropertyKey::number/)
  assert.match(emit('gea::reflectHas', keys.symbol), /nativeDynamicHasProperty[^\n]*PropertyKey::symbol/)
  assert.match(emit('gea::reflectDelete', keys.symbol), /nativeDynamicDelete[^\n]*PropertyKey::symbol/)
  assert.doesNotMatch(emit('gea::reflectSet', keys.string), /Value::box\([^)]*gea_target/)
})

test('native indexed writes convert optional union payloads into fixed slots without losing attributes', () => {
  const table = createStructuralTypeTable()
  const number = table.intern({ kind: 'primitive', primitive: 'number' })
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const undefinedType = table.intern({ kind: 'primitive', primitive: 'undefined' })
  const maybeNumber = table.intern({ kind: 'union', members: [number, undefinedType] })
  const mixed = table.intern({ kind: 'union', members: [number, string, undefinedType] })
  const shape = table.intern({
    kind: 'object',
    members: [
      { key: { kind: 'string', value: 'fixed' }, type: number, optional: false, readonly: false, accessor: null },
      { key: { kind: 'string', value: 'maybe' }, type: maybeNumber, optional: false, readonly: false, accessor: null }
    ],
    index: [{ key: 'string', value: mixed, readonly: false }],
    membersDropped: false
  })
  const deriver = createRepresentationDeriver(table.seal())
  const carrier = deriver.derive(shape)
  assert.equal(carrier.kind, 'record-with-index')
  const input = carrier.indexes[0]!.value
  assert.equal(input.kind, 'optional')
  assert.equal(input.payload.kind, 'tagged-union')
  const numericArm = input.payload.arms.findIndex((arm) => arm.value.kind === 'scalar')
  const textArm = input.payload.arms.findIndex((arm) => arm.value.kind === 'string')
  assert.ok(numericArm >= 0 && textArm >= 0)
  const rendered = cppRecordDeclarations(planOf(carrier), deriver, new Map(), emptyReactivePlan, new Map())
  assert.deepEqual(rendered.refused, [])
  const generated = rendered.declarations.join('\n')
  assert.match(
    generated,
    /NativeFieldWrite\(gea_value, gea::NativeFieldOptionalPolicy<false, gea::NativeFieldUnionPolicy<gea::NativeFieldLeafPolicy, gea::NativeFieldLeafPolicy>>\{\}\)/,
    'indexed sources publish both their outer optional and each union-arm absence policy'
  )
  assert.match(
    generated,
    /assign<gea::NativeFieldOptionalPolicy<false, gea::NativeFieldLeafPolicy>>\(maybe\)/,
    'fixed destinations publish their own optional absence policy'
  )
  const executable = resolve(import.meta.dirname, `../../measurements/cxx/native-index-field-transport-test${executableSuffix}`)
  const source = `
#include "gea_runtime.h"
${generated}
int main() {
  ${cppRecordStructName(shape)} value{};
  using Input = ${cppTypeOf(input)};
  using Present = ${cppTypeOf(input.payload)};
  const auto fixed = gea::PropertyKey::string("fixed");
  const auto maybe = gea::PropertyKey::string("maybe");
  const Input number(Present::ofArm<${numericArm}>(5.0));
  const Input text(Present::ofArm<${textArm}>(std::string("wrong")));
  const Input absent{};
  if (!value.gea_writeOwnIndexNative(fixed, number) || value.fixed != 5.0) return 1;
  if (value.gea_writeOwnIndexNative(fixed, text) || value.fixed != 5.0) return 2;
  if (value.gea_writeOwnIndexNative(fixed, absent) || value.fixed != 5.0) return 3;
  if (!value.gea_writeOwnIndexNative(maybe, number) || !value.maybe.has_value() || *value.maybe != 5.0) return 4;
  if (!value.gea_writeOwnIndexNative(maybe, absent) || value.maybe.has_value()) return 5;
  if (value.gea_dynamic.has("fixed") || value.gea_dynamic.has("maybe")) return 6;
  value.gea_attributes_fixed.writable = false;
  if (value.gea_writeOwnIndexNative(fixed, number)) return 7;
  value.gea_present_maybe = false;
  if (value.gea_writeOwnIndexNative(maybe, number, false) || value.gea_present_maybe) return 8;
  if (!value.gea_writeOwnIndexNative(maybe, number) || !value.gea_present_maybe || *value.maybe != 5.0) return 9;
  return 0;
}
`
  try {
    const compiled = spawnSync(
      process.env.CXX ?? 'clang++',
      [
        '-std=c++20',
        '-fsanitize=address,undefined',
        ...sanitizerArguments,
        `-I${resolve(import.meta.dirname, '../../src/targets/cpp/runtime')}`,
        '-x',
        'c++',
        '-',
        '-o',
        executable
      ],
      { input: source, encoding: 'utf8' }
    )
    assert.equal(compiled.status, 0, [compiled.stdout, compiled.stderr, compiled.error?.message].filter(Boolean).join('\n'))
    const executed = spawnSync(executable, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: sanitizerPath(), UBSAN_OPTIONS: 'halt_on_error=1' }
    })
    assert.equal(executed.status, 0, [executed.stdout, executed.stderr, executed.error?.message].filter(Boolean).join('\n'))
  } finally {
    try {
      unlinkSync(executable)
    } catch {}
  }
})
