#include "gea_runtime.h"
#include <cassert>
#include <string_view>

struct State {
  static constexpr bool gea_traceLeaf = true;
  double base = 10;
};

using Source = gea::CallableObject<double(double)>;
using View = gea::CallableObject<double(double, double)>;

static double firstSource(void* environment, double value) { return static_cast<State*>(environment)->base + value; }
static double secondSource(void* environment, double value) { return static_cast<State*>(environment)->base * 2 + value; }
static double firstAdapter(void* environment, double value, double extra) {
  return static_cast<Source*>(environment)->call(value) + extra;
}
static double secondAdapter(void* environment, double value, double extra) {
  return static_cast<Source*>(environment)->call(value) - extra;
}
static double firstInPlace(void* environment, double value, double extra) { return firstSource(environment, value) + extra; }
static double secondInPlace(void* environment, double value, double extra) { return firstSource(environment, value) - extra; }
static double firstReceiver(void* environment, const gea::NativeCallReceiver& receiver, double value, double extra) {
  return firstAdapter(environment, value, extra) + receiver.as<State>()->base;
}
static double secondReceiver(void* environment, const gea::NativeCallReceiver& receiver, double value, double extra) {
  return secondAdapter(environment, value, extra) - receiver.as<State>()->base;
}
static double inPlaceReceiver(void* environment, const gea::NativeCallReceiver& receiver, double value, double extra) {
  return firstInPlace(environment, value, extra) + receiver.as<State>()->base;
}

template <typename Work>
static void refuses(Work work) {
  bool refused = false;
  try { work(); } catch (const std::runtime_error&) { refused = true; }
  assert(refused);
}

static std::size_t metadataNodes() {
  std::size_t count = 0;
  for (auto* node = View::sourceRegistrations().load(std::memory_order_acquire); node; node = node->next) ++count;
  for (auto* node = View::receiverRegistrations().load(std::memory_order_acquire); node; node = node->next) ++count;
  return count;
}

static void distinctEntriesKeepTheirOwnSourceAndReceiver() {
  auto state = gea::makeRef<State>();
  Source first{Source::entryWithFacts<&firstSource>("first", 1, "function first(value) {}"),
               gea::PackedEnvironment{state.get(), gea::Ref<void>(state), nullptr}};
  Source second{Source::entryWithFacts<&secondSource>("second", 1, "function second(value) {}"),
                gea::PackedEnvironment{state.get(), gea::Ref<void>(state), nullptr}};
  first.functionObjectIdentity();
  second.functionObjectIdentity();
  auto left = View::adaptSource(first, &firstAdapter);
  auto right = View::adaptSource(second, &secondAdapter);
  assert(left.invoke == &firstAdapter && right.invoke == &secondAdapter);
  assert(left.call(3, 2) == 15 && right.call(3, 2) == 21);
  assert(left.functionObjectIdentity() == first.functionObjectIdentity());
  assert(right.functionObjectIdentity() == second.functionObjectIdentity());
  assert(left.facts().name == "first" && left.facts().length == 1 && left.sourceText() == "function first(value) {}");
  assert(right.facts().name == "second" && right.facts().length == 1 && right.sourceText() == "function second(value) {}");

  // The same adapter entry reads the source in THIS environment, rather than
  // remembering the first source object ever passed to that template.
  auto another = View::adaptSource(second, &firstAdapter);
  assert(another.call(3, 2) == 25 && another.facts().name == "second");
  assert(another.functionObjectIdentity() == second.functionObjectIdentity());

  auto receiver = gea::makeRef<State>();
  receiver->base = 100;
  auto methodLeft = View::adaptSourceWithReceiver(first, &firstAdapter, &firstReceiver);
  auto methodRight = View::adaptSourceWithReceiver(second, &secondAdapter, &secondReceiver);
  assert(methodLeft.callWithReceiver(gea::NativeCallReceiver::object(receiver), 3, 2) == 115);
  assert(methodRight.callWithReceiver(gea::NativeCallReceiver::object(receiver), 3, 2) == -79);
  refuses([&] { View::adaptSourceWithReceiver(first, &firstAdapter, &secondReceiver); });
  refuses([&] { View::adaptSourceInPlace<&firstSource>(first, &firstAdapter); });
  assert(methodLeft.callWithReceiver(gea::NativeCallReceiver::object(receiver), 3, 2) == 115);

  const auto nodes = metadataNodes();
  const auto created = gea::detail::allocationProfile().created;
  for (int index = 0; index < 100; ++index) {
    assert(left.call(3, 2) == 15);
    assert(right.call(3, 2) == 21);
    assert(left.facts().name == "first");
    assert(methodLeft.callWithReceiver(gea::NativeCallReceiver::object(receiver), 3, 2) == 115);
  }
  assert(metadataNodes() == nodes);
  assert(gea::detail::allocationProfile().created == created);

  const auto before = gea::detail::allocationProfile().created;
  auto inPlaceLeft = View::adaptSourceInPlace<&firstSource>(first, &firstInPlace);
  auto inPlaceRight = View::adaptSourceInPlace<&firstSource>(first, &secondInPlace);
  auto inPlaceMethod = View::adaptSourceInPlaceWithReceiver<&firstSource>(first, &firstInPlace, &inPlaceReceiver);
  assert(gea::detail::allocationProfile().created == before);
  assert(inPlaceLeft.environment == first.environment && inPlaceRight.environment == first.environment);
  assert(inPlaceLeft.environmentOwner.get() == first.environmentOwner.get());
  assert(inPlaceLeft.functionObjectIdentity() == first.functionObjectIdentity());
  assert(inPlaceRight.functionObjectIdentity() == first.functionObjectIdentity());
  assert(inPlaceLeft.facts().name == "first" && inPlaceRight.facts().name == "first");
  assert(inPlaceLeft.call(3, 2) == 15 && inPlaceRight.call(3, 2) == 11);
  assert(inPlaceMethod.callWithReceiver(gea::NativeCallReceiver::object(receiver), 3, 2) == 115);
  refuses([&] { View::adaptSourceInPlace<&secondSource>(second, &firstInPlace); });
}

using Argument = gea::TaggedUnion<gea::Undefined, double>;
using Pack = gea::Ref<gea::ArrayObject<Argument>>;
using Packed = gea::CallableObject<double(Argument, Argument, Pack)>;
static double count(void*, Argument, Argument, Pack arguments) { return arguments->length(); }

static void runtimePointersRequireAnExistingExactFrame() {
  const auto actual = Packed::entryWithArgumentFrame<&count, 2, true, false>();
  const auto suffix = Packed::entryWithArgumentFrame<&count, 2, false, false>();
  assert((Packed::entryWithArgumentFrame<nullptr, 2, true, false>(actual) == actual));
  assert((Packed::entryWithArgumentFrame<nullptr, 2, false, false>(suffix) == suffix));
  auto boxed = gea::Value::box(gea::Value::Tag::Function, Packed{actual, nullptr});
  assert(boxed.actualArguments() && boxed.restFrom() == 2);
  assert(boxed.callAsFunction({}).as<double>() == 0);
  assert(boxed.callAsFunction({gea::Value()}).as<double>() == 1);
  refuses([&] { Packed::entryWithArgumentFrame<nullptr, 2, false, false>(actual); });
  refuses([&] { Packed::entryWithArgumentFrame<nullptr, 2, true, true>(actual); });
  refuses([&] { Packed::entryWithArgumentFrame<nullptr, -1, false, false>(actual); });
  refuses([&] { Packed::entryWithArgumentFrame<nullptr, 2, true, false>(&count); });
  refuses([&] { Packed::entryWithArgumentFrame<nullptr, -1, false, false>(nullptr); });

  // Lambda objects still use their distinct constant wrapper and registration.
  auto adapter = [](void* environment, double value, double extra) { return firstAdapter(environment, value, extra); };
  auto state = gea::makeRef<State>();
  Source source{&firstSource, gea::PackedEnvironment{state.get(), gea::Ref<void>(state), nullptr}};
  source.functionObjectIdentity();
  auto closure = View::adaptSource(source, adapter);
  auto pointer = View::adaptSource(source, +adapter);
  assert(closure.invoke != pointer.invoke);
  assert(closure.call(3, 2) == 15 && pointer.call(3, 2) == 15);
  assert(closure.functionObjectIdentity() == pointer.functionObjectIdentity());
  assert(closure.facts().name == pointer.facts().name && closure.sourceText() == pointer.sourceText());
}

int main() {
  distinctEntriesKeepTheirOwnSourceAndReceiver();
  runtimePointersRequireAnExistingExactFrame();
}
