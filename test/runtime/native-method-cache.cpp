#include "gea_runtime.h"
#include <cassert>

struct Owner {};
void methodDeclaration() {}

int main() {
  using Body = gea::CallableObject<double()>;
  using Public = gea::CallableObject<double(double)>;
  auto state = gea::makeRef<gea::NativeClassMethodState>();
  state->declaration = &gea::nativeClassMethodDeclaration<Owner>;
  int factoryCalls = 0;
  auto factory = [&]() {
    ++factoryCalls;
    auto original = gea::nativeClassMethodValue<Owner, &methodDeclaration>(
      state, Body{+[](void*) { return 17.0; }, gea::nativeClassMethodEnvironment(state)});
    return Public::adaptSource(std::move(original), +[](void* environment, double) {
      return static_cast<Body*>(environment)->call();
    });
  };
  auto first = gea::nativeClassAdaptedMethodValue<Owner, &methodDeclaration, Public>(state, factory);
  for (int index = 0; index < 1000; ++index) {
    auto next = gea::nativeClassAdaptedMethodValue<Owner, &methodDeclaration, Public>(state, factory);
    assert(next.call(index) == 17.0);
    assert(next.functionObjectIdentity() == first.functionObjectIdentity());
  }
  assert(factoryCalls == 1);
  auto secondState = gea::makeRef<gea::NativeClassMethodState>();
  secondState->declaration = &gea::nativeClassMethodDeclaration<Owner>;
  auto second = gea::nativeClassAdaptedMethodValue<Owner, &methodDeclaration, Public>(secondState, [&]() {
    ++factoryCalls;
    auto original = gea::nativeClassMethodValue<Owner, &methodDeclaration>(
      secondState, Body{+[](void*) { return 19.0; }, gea::nativeClassMethodEnvironment(secondState)});
    return Public::adaptSource(std::move(original), +[](void* environment, double) {
      return static_cast<Body*>(environment)->call();
    });
  });
  assert(factoryCalls == 2);
  assert(second.call(0) == 19.0);
  assert(second.functionObjectIdentity() != first.functionObjectIdentity());
  gea::WeakRef<gea::NativeClassMethodState> weakFirst(state), weakSecond(secondState);
  first = Public{};
  second = Public{};
  state = {};
  secondState = {};
  assert(!weakFirst.expired() && !weakSecond.expired());
  gea::collectCycles();
  assert(weakFirst.expired() && weakSecond.expired());
}
