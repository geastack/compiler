#include "gea_runtime.h"
#include <cassert>

struct Tracked {
  static inline int copies = 0;
  int value;
  explicit Tracked(int value_) : value(value_) {}
  Tracked(const Tracked& other) : value(other.value) { ++copies; }
  Tracked(Tracked&&) = default;
};
int borrowed(const Tracked& value) { return value.value; }
int known(void*, Tracked value) { return borrowed(value); }
int replaced(void*, Tracked value) { return value.value + 1; }
int construct(void*) { return 0; }

template <typename Callable> void check(Callable& callable) {
  Tracked value(42);
  Tracked::copies = 0;
  assert((callable.template callKnownBorrowed<&known, &borrowed>(value) == 42));
  assert(Tracked::copies == 0);
  callable.invoke = &replaced;
  assert((callable.template callKnownBorrowed<&known, &borrowed>(value) == 43));
  assert(Tracked::copies == 1);
}

int main() {
  gea::CallableObject<int(Tracked)> function(&known, nullptr);
  check(function);
  gea::CallableConstructorObject<int(Tracked), int()> constructor(&known, &construct, nullptr);
  check(constructor);
  // An incompatible candidate must never instantiate its borrowed body call.
  gea::CallableObject<int()> other(+[](void*) { return 7; }, nullptr);
  assert((other.callKnownBorrowed<&known, &borrowed>() == 7));
}
