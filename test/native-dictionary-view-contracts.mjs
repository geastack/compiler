import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'measurements/native-dictionary-view-contracts')
const source = `#include "gea_runtime.h"
#include <cassert>
#include <iostream>
struct Key { double id; explicit Key(double id_) : id(id_) {} };
struct Cycle {
  gea::Ref<gea::Dictionary<std::string>> view;
  friend void geaTraceRefs(const Cycle& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.view, visitor); }
};
template <typename Run> void mustThrow(Run run) {
  bool threw = false;
  try { run(); } catch (...) { threw = true; }
  assert(threw);
}
int main() {
  using Dynamic = gea::Dictionary<gea::Value>;
  using Typed = gea::Dictionary<gea::Ref<Key>>;
  const auto owner = gea::makeRef<Dynamic>();
  const auto first = gea::makeRef<Key>(1);
  owner->setProperty("first", gea::Value::box(gea::Value::Tag::Object, first));
  const auto typed = gea::dictionary::nativeView<Typed>(owner,
    [](const gea::Value& value) { return gea::dictionary::checkedClassEntry<Key>(value); },
    [](const gea::Ref<Key>& value) { return gea::Value::box(gea::Value::Tag::Object, value); });
  assert(typed->read("first") == first);
  assert(typed == owner);
  const auto second = gea::makeRef<Key>(2);
  assert(typed->setProperty("second", second));
  assert(owner->read("second").as<gea::Ref<Key>>() == second);
  owner->setProperty("first", gea::Value::box(gea::Value::Tag::Object, second));
  assert(typed->read("first") == second);
  const auto ownerBox = gea::Value::box(gea::Value::Tag::Object, owner);
  const auto typedBox = gea::Value::box(gea::Value::Tag::Object, typed);
  assert(gea::Value::strictEquals(ownerBox, typedBox));
  assert(ownerBox.identity() == typedBox.identity());
  assert(typedBox.as<gea::Ref<Typed>>() == typed);
  const auto nested = gea::dictionary::nativeReadOnlyView<Typed>(typed, [](const gea::Ref<Key>& value) { return value; });
  assert(nested == owner);
  assert(gea::Value::sameValue(ownerBox, gea::Value::box(gea::Value::Tag::Object, nested)));
  assert(typed->definePropertyFrom("hidden", first, false, false, false));
  assert(!owner->attributesOf("hidden").enumerable);
  assert(!typed->setProperty("hidden", second));
  assert(!typed->deleteProperty("hidden"));
  assert(typed->deleteProperty("second"));
  assert(!owner->has("second"));
  owner->setProperty("bad", gea::Value::box(gea::Value::Tag::Number, 42.0));
  const auto bad = gea::PropertyKey::string("bad");
  assert(typedBox.getProperty(bad).as<double>() == 42.0);
  const auto* typedFields = gea::detail::nativeFieldOpsFor<gea::Ref<Typed>>();
  gea::Value dynamicEntry;
  assert(typedFields->readIndex(&typed, bad, dynamicEntry) && dynamicEntry.as<double>() == 42.0);
  gea::PropertyDescriptor dynamicDescriptor;
  assert(typedFields->ownIndexDescriptor(&typed, bad, dynamicDescriptor) && dynamicDescriptor.value.as<double>() == 42.0);
  const auto broadWritten = gea::Value::box(gea::Value::Tag::String, std::string("still broad"));
  assert(typedFields->writeIndex(const_cast<gea::Ref<Typed>*>(&typed), bad, broadWritten, true));
  assert(owner->read("bad").as<std::string>() == "still broad");
  assert(typedBox.getProperty(bad).as<std::string>() == "still broad");
  assert(typed->propertyKeys().size() == 3);
  gea::ArrayObject<std::string> keys;
  typed->keysInto(keys, true);
  assert(keys.size() == 2);
  mustThrow([&] { (void)typed->read("bad"); });
  int effects = 0;
  mustThrow([&] {
    for (const std::string& key : typed->enumerableKeys()) {
      (void)typed->read(key);
      ++effects;
    }
  });
  assert(effects == 1);
  owner->deleteProperty("hidden");
  owner->erase("hidden");
  effects = 0;
  mustThrow([&] { for (const auto& entry : *typed) { (void)entry; ++effects; } });
  assert(effects == 1);
  assert(typed->setProperty("undefined", gea::Ref<Key>::undefined()));
  assert(owner->read("undefined").tag() == gea::Value::Tag::Undefined);
  assert(typed->read("undefined").isUndefined());
  assert(typed->setProperty("null", gea::Ref<Key>{}));
  assert(owner->read("null").tag() == gea::Value::Tag::Null);
  assert(!typed->read("null") && !typed->read("null").isUndefined());
  using Wide = gea::TaggedUnion<std::string, double>;
  const auto table = gea::makeRef<gea::Dictionary<std::string>>();
  table->setProperty("x", "old");
  const auto readonly = gea::dictionary::nativeReadOnlyView<gea::Dictionary<Wide>>(table,
    [](const std::string& value) { return Wide::ofArm<0>(value); });
  table->setProperty("x", "new");
  assert(readonly->read("x").get<0>() == "new");
  mustThrow([&] { readonly->setProperty("x", Wide::ofArm<1>(3.0)); });
  mustThrow([&] { readonly->definePropertyFrom("x", Wide::ofArm<0>("bad"), true, true, true); });
  mustThrow([&] { readonly->deleteProperty("x"); });
  assert(table->read("x") == "new");
  const auto numbers = gea::makeRef<gea::NumericDictionary<gea::Value>>();
  numbers->setProperty(2.0, gea::Value::box(gea::Value::Tag::Object, first));
  const auto numeric = gea::dictionary::nativeView<gea::NumericDictionary<gea::Ref<Key>>>(numbers,
    [](const gea::Value& value) { return gea::dictionary::checkedClassEntry<Key>(value); },
    [](const gea::Ref<Key>& value) { return gea::Value::box(gea::Value::Tag::Object, value); });
  assert(numeric->read(2.0) == first);
  assert(numeric->has("2") && numeric->read("2") == first);
  const std::string numericKey = "2";
  assert(numeric->has(numericKey) && numeric->read(numericKey) == first);
  const std::string_view numericKeyView = numericKey;
  assert(numeric->has(numericKeyView) && numeric->read(numericKeyView) == first);
  assert(numeric == numbers);
  numeric->setProperty(-0.0, second);
  assert(numbers->read(0.0).as<gea::Ref<Key>>() == second);
  assert(numbers->has("0") && numeric->read("0") == second);
  assert(numeric->deleteProperty(2.0) && !numbers->has(2.0));
  const auto undefined = gea::dictionary::nativeReadOnlyView<gea::Dictionary<Wide>>(gea::Ref<gea::Dictionary<std::string>>::undefined(),
    [](const std::string& value) { return Wide::ofArm<0>(value); });
  assert(undefined.isUndefined());
  const auto null = gea::dictionary::nativeReadOnlyView<gea::Dictionary<Wide>>(gea::Ref<gea::Dictionary<std::string>>{},
    [](const std::string& value) { return Wide::ofArm<0>(value); });
  assert(!null && !null.isUndefined());
  gea::WeakRef<gea::Dictionary<gea::Ref<Cycle>>> weakOwner;
  gea::WeakRef<gea::Dictionary<std::string>> weakView;
  {
    const auto cyclicOwner = gea::makeRef<gea::Dictionary<gea::Ref<Cycle>>>();
    const auto cycle = gea::makeRef<Cycle>();
    cyclicOwner->setProperty("cycle", cycle);
    const auto view = gea::dictionary::nativeReadOnlyView<gea::Dictionary<std::string>>(cyclicOwner,
      [](const gea::Ref<Cycle>&) { return std::string("read"); });
    cycle->view = view;
    weakOwner = gea::WeakRef<gea::Dictionary<gea::Ref<Cycle>>>(cyclicOwner);
    weakView = gea::WeakRef<gea::Dictionary<std::string>>(view);
  }
  gea::collectCycles();
  assert(!weakOwner.lock() && !weakView.lock());
  std::cout << "Native dictionary view contracts passed\\n";
}
`

execFileSync(
  process.env.CXX ?? 'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-g',
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-',
    '-o',
    executable
  ],
  { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
)
const output = execFileSync(executable, [], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
assert.equal(output, 'Native dictionary view contracts passed\n')
process.stdout.write(output)
