import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const binary = resolve(output, 'native-callable-prototype')
const source = `#include "gea_runtime.h"
#include <cassert>
#include <iostream>
using Argument = gea::TaggedUnion<gea::Undefined, double>;
using Pack = gea::Ref<gea::ArrayObject<Argument>>;
using Function = gea::CallableObject<double(gea::Value, Argument, Pack)>;
static int functionObservations = 0;
static int prototypeObservations = 0;
double body(void*, gea::Value receiver, Argument first, Pack actual) {
  return (receiver.tag() == gea::Value::Tag::Number ? receiver.as<double>() : 0.0) +
      (first.is<1>() ? first.get<1>() : 0.0) + actual->length();
}
gea::Value observeFunction(const Function& function) {
  ++functionObservations;
  return gea::Value::boxMethod<2, true>(function);
}
gea::Value observePrototype(const gea::Ref<gea::DynamicObject>& table) {
  ++prototypeObservations;
  return gea::Value::fromDynamicObject(table);
}
int main() {
  Function function{Function::entryWithArgumentFrame<&body, 2, true, true>(), nullptr};
  gea::installCallableNativePrototype(function);
  const auto& identity = function.functionObjectIdentity();
  const auto* descriptor = identity->properties->ownProperty(gea::PropertyKey::string("prototype"));
  assert(descriptor && descriptor->nativeValue && descriptor->writable && !descriptor->enumerable && !descriptor->configurable);
  const auto* held = descriptor->nativeValue.get<gea::Ref<gea::DynamicObject>>();
  assert(held && *held);
  const auto table = *held;
  const auto* backpointer = table->ownProperty(gea::PropertyKey::string("constructor"));
  assert(backpointer && backpointer->nativeValue && backpointer->writable && !backpointer->enumerable && backpointer->configurable);
  const auto* original = backpointer->nativeValue.get<Function>();
  assert(original && original->functionObjectIdentity() == identity);
  assert(functionObservations == 0 && prototypeObservations == 0);
  auto unchanged = *descriptor;
  assert(descriptor->sameDataValue(unchanged));
  identity->properties->freezeIntegrity();
  assert(identity->properties->hasFrozenIntegrity());
  assert(functionObservations == 0 && prototypeObservations == 0);
  // Publishing an actual observation after freezing changes no value/flags.
  gea::installCallableNativePrototype(function, &observeFunction, &observePrototype);
  const auto prototype = identity->properties->get(gea::PropertyKey::string("prototype"), gea::Value());
  assert(prototype.isDynamicObject() && prototype.asDynamicObject() == table);
  assert(functionObservations == 0 && prototypeObservations == 1);
  const auto constructor = prototype.getProperty(gea::PropertyKey::string("constructor"));
  assert(constructor.functionObjectIdentity() == identity);
  assert(constructor.receivesThis() && constructor.actualArguments() && constructor.restFrom() == 2);
  assert(functionObservations == 1);
  const auto callResult = [&](std::vector<gea::Value> arguments, double expected) {
    const double actual = constructor.callWithReceiver(gea::Value::box(gea::Value::Tag::Number, 10.0), arguments).as<double>();
    if (actual != expected) std::cerr << "prototype constructor call: actual=" << actual << " expected=" << expected << '\\n';
    assert(actual == expected);
  };
  callResult({}, 10);
  callResult({gea::Value()}, 11);
  callResult({gea::Value::box(gea::Value::Tag::Number, 4.0)}, 15);
  const auto nativeReceiver = gea::NativeCallReceiver::fromValue(gea::Value::box(gea::Value::Tag::Number, 10.0));
  assert(constructor.callWithReceiver(nativeReceiver, {}).as<double>() == 10);
  assert(constructor.callWithReceiver(nativeReceiver, {gea::Value()}).as<double>() == 11);
  const auto again = gea::callableNativeOwnPrototypeGet(function, &observeFunction);
  assert(again.asDynamicObject() == table);
  assert(identity->properties->hasFrozenIntegrity());
  assert(!identity->properties->setNativeDataWithReceiver<gea::Ref<gea::DynamicObject>>(gea::PropertyKey::string("prototype"), gea::makeRef<gea::DynamicObject>(), nullptr, [] { return gea::Value(); }));
  assert(table->readNativeData<Function>(gea::PropertyKey::string("constructor"))->functionObjectIdentity() == identity);
  std::cout << "NATIVE_CALLABLE_PROTOTYPE_OK\\n";
}
`
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
    binary
  ],
  { input: source, env: { ...process.env, TMPDIR: output } }
)
assert.equal(
  execFileSync(binary, { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } }),
  'NATIVE_CALLABLE_PROTOTYPE_OK\n'
)
console.log('PASS native Function prototype/backpointer')
