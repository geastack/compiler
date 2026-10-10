import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const binary = resolve(output, 'native-arguments-frame')
const source = `#include "gea_runtime.h"
#include <cassert>
#include <iostream>
using Arg = gea::TaggedUnion<gea::Undefined, std::nullptr_t, double>;
using Pack = gea::Ref<gea::ArrayObject<Arg>>;
using Fn = gea::CallableObject<double(Arg, Arg, Pack)>;
double count(void*, Arg, Arg, Pack actual) { return actual->length(); }
using ErasedPack = gea::Ref<gea::ArrayObject<gea::Value>>;
double erasedCount(void*, ErasedPack actual) { return actual->length(); }
struct Receiver { static constexpr bool gea_traceLeaf = true; double base = 10; };
double methodCount(void*, gea::Ref<Receiver> receiver, Arg, Arg, Pack actual) { return receiver->base + actual->length(); }
int main() {
  Fn actual{Fn::entryWithArgumentFrame<&count, 2, true, false>(), nullptr};
  auto boxed = gea::Value::box(gea::Value::Tag::Function, actual);
  assert(boxed.restFrom() == 2 && boxed.actualArguments() && !boxed.receivesThis());
  assert(boxed.callAsFunction({}).as<double>() == 0);
  assert(boxed.callAsFunction({gea::Value()}).as<double>() == 1);
  assert(boxed.callAsFunction({gea::Value::box(gea::Value::Tag::Null, nullptr)}).as<double>() == 1);
  assert(boxed.callAsFunction({gea::Value::box(gea::Value::Tag::Number, 4.0), gea::Value::box(gea::Value::Tag::Number, 5.0)}).as<double>() == 2);
  Fn suffix{Fn::entryWithArgumentFrame<&count, 2, false, false>(), nullptr};
  auto suffixBox = gea::Value::box(gea::Value::Tag::Function, suffix);
  assert(!suffixBox.actualArguments());
  assert(suffixBox.callAsFunction({gea::Value(), gea::Value(), gea::Value()}).as<double>() == 1);
  using Factory = gea::CallableObject<Fn()>;
  auto factory = Factory{+[](void* held) -> Fn { return *static_cast<Fn*>(held); }, gea::packEnvironment(actual)};
  auto returned = gea::Value::box(gea::Value::Tag::Function, factory).callAsFunction({});
  assert(returned.actualArguments() && returned.restFrom() == 2);
  assert(returned.functionObjectIdentity() == boxed.functionObjectIdentity());
  assert(returned.callAsFunction({gea::Value()}).as<double>() == 1);
  auto recovered = gea::detail::DynamicCarrier<Fn>::inWithRest<2, true>(returned, 0);
  assert(recovered.invoke == actual.invoke);
  using ErasedFn = gea::CallableObject<double(ErasedPack)>;
  ErasedFn erased{ErasedFn::entryWithArgumentFrame<&erasedCount, 0, false, false>(), nullptr};
  auto adapted = gea::detail::DynamicCarrier<Fn>::inWithRest<2, true>(gea::Value::box(gea::Value::Tag::Function, erased), 0);
  auto one = gea::arrayOf<Arg>({Arg::ofArm<2>(4.0)});
  assert(adapted.call(Arg::ofArm<0>(gea::Undefined{}), Arg::ofArm<0>(gea::Undefined{}), one) == 1);
  auto adaptedBox = gea::Value::box(gea::Value::Tag::Function, adapted);
  assert(adaptedBox.actualArguments() && adaptedBox.callAsFunction({gea::Value()}).as<double>() == 1);
  using Method = gea::CallableObject<double(gea::Ref<Receiver>, Arg, Arg, Pack)>;
  Method method{Method::entryWithArgumentFrame<&methodCount, 3, true, true>(), nullptr};
  auto owner = gea::makeRef<Receiver>();
  auto methodBox = gea::Value::box(gea::Value::Tag::Function, method);
  assert(methodBox.receivesThis() && methodBox.actualArguments());
  assert(methodBox.callWithReceiver(gea::NativeCallReceiver::object(owner), {gea::Value()}).as<double>() == 11);
  auto detached = Fn::unboundMethod(method);
  auto detachedBox = gea::Value::box(gea::Value::Tag::Function, detached);
  assert(!detachedBox.receivesThis() && detachedBox.actualArguments() && detachedBox.restFrom() == 2);
  assert(detachedBox.callWithReceiver(gea::NativeCallReceiver::object(owner), {gea::Value()}).as<double>() == 11);
  std::cout << "Native actual arguments frames passed\\n";
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
  {
    input: source,
    env: { ...process.env, TMPDIR: output }
  }
)
assert.equal(
  execFileSync(binary, { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } }),
  'Native actual arguments frames passed\n'
)
console.log('PASS native actual arguments frames')
