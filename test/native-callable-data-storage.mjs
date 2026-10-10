import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'measurements/native-callable-data-storage')
const source = `#include "gea_runtime.h"
#include <cassert>
#include <limits>
#include <iostream>

struct NativeObject final { static constexpr bool gea_traceLeaf = true; double number = 1; };
using Function = gea::CallableObject<double(double)>;
double original(void*, double value) { return value; }
double replacement(void*, double value) { return value + 1; }
int materializations = 0;
int numberMaterializations = 0;
gea::Value materializeNumber(const double& value) {
  ++numberMaterializations;
  return gea::Value::box(gea::Value::Tag::Number, value);
}
gea::Value materialize(const Function& value) {
  ++materializations;
  return gea::Value::box(gea::Value::Tag::Function, value);
}

int main() {
  const Function target{&original, nullptr};
  const Function installed{&replacement, nullptr};
  const auto& identity = target.functionObjectIdentity();
  gea::installCallableOwnFacts(identity, "target", 1);
  const auto& properties = identity->properties;
  const auto key = gea::PropertyKey::string("call");
  assert(properties->setNativeDataWithReceiver(key, installed, &materialize,
      [&] { assert(false && "a data store must not request its native receiver"); return gea::Value(); }));
  assert(materializations == 0);
  const auto stored = properties->readNativeData<Function>(key);
  assert(stored && stored->functionObjectIdentity() == installed.functionObjectIdentity());
  assert(stored->call(4) == 5);
  assert(materializations == 0);
  const auto descriptor = properties->ownProperty(key);
  assert(descriptor && descriptor->isData() && !descriptor->isAccessor());
  assert(descriptor->writable && descriptor->enumerable && descriptor->configurable);
  const auto keys = properties->ownKeys();
  assert(keys.size() == 3 && keys[0].text() == "name" && keys[1].text() == "length" && keys[2].text() == "call");

  const auto dynamic = properties->getWithReceiver(key,
      [&] { assert(false && "a data read must not request its native receiver"); return gea::Value(); });
  assert(materializations == 1);
  assert(gea::Value::strictEqualsCallable(dynamic, installed));
  assert(dynamic.callAsFunction({gea::Value::box(gea::Value::Tag::Number, 4.0)}).as<double>() == 5);

  const Function symbolOwner{&original, nullptr};
  const auto ownerReceiver = gea::NativeCallReceiver::primitive(symbolOwner, &materialize);
  const auto symbolKey = gea::PropertyKey::symbol(gea::symbolFor("native-data-writer"));
  assert(gea::callableNativeDataSetWithReceiver(symbolOwner, symbolKey, 17.0, &materializeNumber, ownerReceiver));
  assert(numberMaterializations == 0 && materializations == 1);
  const auto symbolTable = symbolOwner.functionObjectIdentity()->properties;
  const auto nativeNumber = symbolTable->readNativeData<double>(symbolKey);
  assert(nativeNumber && *nativeNumber == 17.0);
  assert(!gea::callableNativeDataSetWithReceiver(symbolOwner, gea::PropertyKey::string("name"), 42.0, &materializeNumber, ownerReceiver));
  assert(numberMaterializations == 0 && materializations == 1);
  assert(symbolTable->getWithNativeReceiver(symbolKey, ownerReceiver).as<double>() == 17.0);
  assert(numberMaterializations == 1 && materializations == 1);
  symbolTable->freezeIntegrity();
  assert(!gea::callableNativeDataSetWithReceiver(symbolOwner, symbolKey, 18.0, &materializeNumber, ownerReceiver));
  assert(!symbolTable->deleteOwnProperty(symbolKey));
  assert(numberMaterializations == 1 && materializations == 1);

  properties->freezeIntegrity();
  assert(properties->hasFrozenIntegrity());
  auto repeated = gea::PropertyDescriptor::nativeAssignment(installed, &materialize);
  repeated.writable = false;
  repeated.configurable = false;
  assert(properties->defineOwnProperty(key, repeated));
  repeated = gea::PropertyDescriptor::nativeAssignment(target, &materialize);
  repeated.writable = false;
  repeated.configurable = false;
  assert(!properties->defineOwnProperty(key, repeated));
  assert(!properties->setNativeDataWithReceiver(key, target, &materialize, [] { return gea::Value(); }));
  assert(!properties->deleteOwnProperty(key));
  assert(materializations == 1 && "native SameValue and integrity must not materialize data");

  auto numbers = gea::makeRef<gea::DynamicObject>();
  auto zero = gea::PropertyDescriptor::nativeAssignment(-0.0);
  zero.writable = false;
  zero.configurable = false;
  assert(numbers->defineOwnProperty(key, zero));
  auto positiveZero = gea::PropertyDescriptor::nativeAssignment(0.0);
  positiveZero.writable = false;
  positiveZero.configurable = false;
  assert(!numbers->defineOwnProperty(key, positiveZero));
  auto nan = gea::PropertyDescriptor::nativeAssignment(std::numeric_limits<double>::quiet_NaN());
  nan.writable = false;
  nan.configurable = false;
  const auto nanKey = gea::PropertyKey::string("nan");
  assert(numbers->defineOwnProperty(nanKey, nan));
  assert(numbers->defineOwnProperty(nanKey, nan));

  using UndefinedOptionalPolicy = gea::NativeFieldOptionalPolicy<false>;
  using NullOptionalPolicy = gea::NativeFieldOptionalPolicy<true>;
  const auto absentOptional = gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>());
  assert(absentOptional.sameValue(gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>())));
  assert(!absentOptional.sameValue(gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>(0.0))));
  const auto nullOptional = gea::NativeDescriptorData::make<gea::Optional<double>, NullOptionalPolicy>(gea::Optional<double>());
  assert(nullOptional.sameValue(gea::NativeDescriptorData::make<gea::Optional<double>, NullOptionalPolicy>(gea::Optional<double>())));
  assert(!absentOptional.sameValue(nullOptional) && !nullOptional.sameValue(absentOptional));
  assert(absentOptional.sameValue(gea::Value()));
  assert(!absentOptional.sameValue(gea::Value::box(gea::Value::Tag::Null, nullptr)));
  assert(nullOptional.sameValue(gea::Value::box(gea::Value::Tag::Null, nullptr)));
  assert(!nullOptional.sameValue(gea::Value()));
  const auto untypedOptional = gea::NativeDescriptorData::make(gea::Optional<double>());
  assert(!untypedOptional.sameValue(untypedOptional));
  assert(!untypedOptional.sameValue(gea::Value()));
  const auto optionalZero = gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>(-0.0));
  assert(optionalZero.sameValue(gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>(-0.0))));
  assert(!optionalZero.sameValue(gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>(0.0))));
  const auto optionalNan = gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>(std::numeric_limits<double>::quiet_NaN()));
  assert(optionalNan.sameValue(gea::NativeDescriptorData::make<gea::Optional<double>, UndefinedOptionalPolicy>(gea::Optional<double>(std::numeric_limits<double>::quiet_NaN()))));
  using DataSumPolicy = gea::NativeFieldUnionPolicy<gea::NativeFieldLeafPolicy, gea::NativeFieldLeafPolicy>;
  using DataSum = gea::TaggedUnion<double, Function>;
  const auto sumZero = gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(DataSum::ofArm<0>(-0.0));
  assert(sumZero.sameValue(gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(DataSum::ofArm<0>(-0.0))));
  assert(!sumZero.sameValue(gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(DataSum::ofArm<0>(0.0))));
  const auto sumFunction = gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(DataSum::ofArm<1>(installed));
  assert(sumFunction.sameValue(gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(DataSum::ofArm<1>(*stored))));
  assert(!sumFunction.sameValue(gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(DataSum::ofArm<1>(target))));
  assert(!sumFunction.sameValue(sumZero));
  using OptionalFunction = gea::Optional<Function>;
  const OptionalFunction freshOptional(Function{&replacement, nullptr});
  const auto optionalFunctionData = gea::NativeDescriptorData::make<OptionalFunction, UndefinedOptionalPolicy>(freshOptional);
  assert(optionalFunctionData.get<OptionalFunction>()->operator->()->functionObjectIdentity() ==
      freshOptional->functionObjectIdentity());
  const DataSum freshSum = DataSum::ofArm<1>(Function{&replacement, nullptr});
  const auto sumFunctionData = gea::NativeDescriptorData::make<DataSum, DataSumPolicy>(freshSum);
  assert(sumFunctionData.get<DataSum>()->get<1>().functionObjectIdentity() == freshSum.get<1>().functionObjectIdentity());
  assert((gea::NativeDescriptorData::make<OptionalFunction, UndefinedOptionalPolicy>(OptionalFunction(installed)).sameValue(
      gea::NativeDescriptorData::make<OptionalFunction, UndefinedOptionalPolicy>(OptionalFunction(*stored)))));
  assert((!gea::NativeDescriptorData::make<OptionalFunction, UndefinedOptionalPolicy>(OptionalFunction(installed)).sameValue(
      gea::NativeDescriptorData::make<OptionalFunction, UndefinedOptionalPolicy>(OptionalFunction(target)))));

  const auto nativeObject = gea::makeRef<NativeObject>();
  const auto objectData = gea::NativeDescriptorData::make(nativeObject);
  assert(objectData.sameValue(gea::Value::box(gea::Value::Tag::Object, nativeObject)));
  assert(!objectData.sameValue(gea::Value::box(gea::Value::Tag::Object, gea::makeRef<NativeObject>())));
  assert(gea::NativeDescriptorData::make(gea::Ref<NativeObject>()).sameValue(gea::Value::box(gea::Value::Tag::Null, nullptr)));
  assert(gea::NativeDescriptorData::make(gea::Ref<NativeObject>::undefined()).sameValue(gea::Value()));

  auto prototype = gea::makeRef<gea::DynamicObject>();
  auto inheritedReadOnly = gea::PropertyDescriptor::nativeAssignment(installed, &materialize);
  inheritedReadOnly.writable = false;
  assert(prototype->defineOwnProperty(key, inheritedReadOnly));
  auto child = gea::makeRef<gea::DynamicObject>();
  assert(child->setPrototype(prototype));
  const auto noReceiver = [] { assert(false && "an inherited data write must not ask for a receiver"); return gea::Value(); };
  assert(!child->setNativeDataWithReceiver(key, target, &materialize, noReceiver));
  assert(!child->setWithReceiver(key, dynamic, noReceiver));
  assert(child->ownProperty(key) == nullptr);
  assert(prototype->readNativeData<Function>(key)->functionObjectIdentity() == installed.functionObjectIdentity());
  assert(materializations == 1);
  const auto writableKey = gea::PropertyKey::string("writable");
  assert(prototype->defineOwnProperty(writableKey, gea::PropertyDescriptor::nativeAssignment(installed)));
  assert(child->setNativeDataWithReceiver(writableKey, target, nullptr, noReceiver));
  assert(child->readNativeData<Function>(writableKey)->functionObjectIdentity() == target.functionObjectIdentity());
  assert(prototype->readNativeData<Function>(writableKey)->functionObjectIdentity() == installed.functionObjectIdentity());

  auto ordered = gea::makeRef<gea::DynamicObject>();
  const auto first = gea::PropertyKey::string("first");
  const auto second = gea::PropertyKey::string("second");
  assert(ordered->setNativeDataWithReceiver(first, installed, nullptr, [] { return gea::Value(); }));
  assert(ordered->setNativeDataWithReceiver(second, target, nullptr, [] { return gea::Value(); }));
  assert(ordered->deleteOwnProperty(first));
  assert(ordered->setNativeDataWithReceiver(first, target, nullptr, [] { return gea::Value(); }));
  const auto reordered = ordered->ownKeys();
  assert(reordered.size() == 2 && reordered[0].text() == "second" && reordered[1].text() == "first");
  assert(!ordered->readNativeData<std::string>(first));

  gea::WeakRef<gea::FunctionObjectIdentity> weakCycle;
  {
    Function cyclic{&original, nullptr};
    const auto& cycleIdentity = cyclic.functionObjectIdentity();
    weakCycle = gea::WeakRef<gea::FunctionObjectIdentity>(cycleIdentity);
    gea::installCallableOwnFacts(cycleIdentity, "cyclic", 1);
    assert(cycleIdentity->properties->setNativeDataWithReceiver(key, cyclic, nullptr, [] { return gea::Value(); }));
  }
  gea::collectCycles();
  assert(weakCycle.expired() && "the native data holder must expose its Function ownership edge to tracing");
  std::cout << "Native callable data storage contracts passed\\n";
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
  { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: resolve(root, 'measurements') } }
)
const output = execFileSync(executable, [], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } })
assert.equal(output, 'Native callable data storage contracts passed\n')
process.stdout.write(output)
