#include "gea_runtime.h"
#include <cassert>
#include <stdexcept>
#include <memory>
#include <string>
#include <type_traits>

static_assert(std::is_trivially_copyable_v<gea::Optional<bool>>);
static_assert(std::is_trivially_copy_assignable_v<gea::Optional<double>>);
static_assert(std::is_trivially_move_assignable_v<gea::Optional<double>>);
static_assert(std::is_trivially_destructible_v<gea::Optional<double>>);
static_assert(std::is_copy_assignable_v<gea::Optional<std::string>>);
static_assert(std::is_move_assignable_v<gea::Optional<std::string>>);
static_assert(std::is_move_assignable_v<gea::Optional<gea::PropertyDescriptor>>);

struct Counted {
  static inline int live = 0;
  static inline bool fail = false;
  int value = 0;
  Counted() { ++live; }
  explicit Counted(int n) : value(n) { ++live; }
  Counted(const Counted& other) : value(other.value) { if (fail) throw std::runtime_error("copy"); ++live; }
  Counted(Counted&& other) noexcept : value(other.value) { ++live; }
  Counted& operator=(const Counted& other) { if (fail) throw std::runtime_error("assign"); value=other.value; return *this; }
  Counted& operator=(Counted&& other) noexcept { value=other.value; return *this; }
  ~Counted() { --live; }
};

// Const reads distinguish an absent unconstructed payload from an absent
// payload deliberately constructed through the mutable compatibility accessor.
void checkState(const gea::Optional<std::string>& value, int state) {
  assert(value.has_value() == (state == 2));
  assert(*value == (state == 0 ? "" : state == 1 ? "latent" : "present"));
}
gea::Optional<std::string> makeState(int state) {
  gea::Optional<std::string> value;
  if (state == 1) *value = "latent";
  if (state == 2) value = std::string("present");
  return value;
}
void checkTransitions() {
  for (int sourceState = 0; sourceState != 3; ++sourceState) {
    for (int destinationState = 0; destinationState != 3; ++destinationState) {
      auto source = makeState(sourceState);
      auto destination = makeState(destinationState);
      assert(&(destination = source) == &destination);
      checkState(source, sourceState);
      checkState(destination, sourceState);
      auto moveSource = makeState(sourceState);
      auto moveDestination = makeState(destinationState);
      assert(&(moveDestination = std::move(moveSource)) == &moveDestination);
      checkState(moveDestination, sourceState);
      assert(moveSource.has_value() == (sourceState == 2));
    }
    auto self = makeState(sourceState);
    assert(&(self = self) == &self);
    checkState(self, sourceState);
    assert(&(self = std::move(self)) == &self);
    checkState(self, sourceState);
  }
}

int main() {
  checkTransitions();
  {
    gea::Optional<std::unique_ptr<int>> source = std::make_unique<int>(19), destination;
    destination = std::move(source);
    assert(destination.has_value() && **destination == 19);
    assert(source.has_value() && !*source);
    gea::Optional<std::unique_ptr<int>> absent;
    destination = std::move(absent);
    assert(!destination.has_value());
  }
  gea::Optional<std::string> empty, present=std::string("first"), target;
  target=present; assert(target.has_value() && *target=="first");
  target=std::move(present); assert(target.has_value() && *target=="first");
  target=target; target=std::move(target); assert(*target=="first");
  target=empty; assert(!target.has_value());
  *empty="constructed"; assert(!empty.has_value());
  target=empty; assert(!target.has_value() && *target=="constructed");
  gea::Optional<std::string> moved; moved=std::move(empty);
  assert(!moved.has_value() && *moved=="constructed");
  moved="literal"; assert(moved.has_value() && *moved=="literal");
  gea::Optional<gea::PropertyDescriptor> a, b;
  a=std::move(b); b=a;
  assert(!a.has_value() && !b.has_value());
  {
    gea::Optional<Counted> source=Counted(7), destination;
    Counted::fail=true;
    try { destination=source; assert(false); } catch (const std::runtime_error&) {}
    assert(!destination.has_value() && Counted::live==1);
    Counted::fail=false;
    gea::Optional<Counted> constructed;
    constructed->value = 23;
    Counted::fail=true;
    try { constructed=source; assert(false); } catch (const std::runtime_error&) {}
    assert(!constructed.has_value() && constructed->value==23 && Counted::live==2);
    Counted::fail=false; constructed=gea::Optional<Counted>();
    assert(Counted::live==1);
    destination=source;
    assert(destination.has_value() && destination->value==7 && Counted::live==2);
    Counted::fail=true;
    try { destination=source; assert(false); } catch (const std::runtime_error&) {}
    assert(destination.has_value() && destination->value==7 && Counted::live==2);
    Counted::fail=false;
    gea::Optional<Counted> absent; destination=std::move(absent);
    assert(!destination.has_value() && Counted::live==1);
  }
  assert(Counted::live==0);
}
