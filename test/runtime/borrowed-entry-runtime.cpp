#include "gea_runtime.h"
#include <cassert>
#include <functional>

struct Payload {
  static inline int copies = 0;
  std::string text;
  explicit Payload(std::string input) : text(std::move(input)) {}
  Payload(const Payload& other) : text(other.text) { ++copies; }
  Payload(Payload&&) = default;
};
using Callback = std::function<void()>;

// The body can re-enter arbitrarily: only the supplied slot's stability is
// required. It does not claim the callee, callback or referent is immutable.
std::string borrowedBody(const Payload& input, Callback callback) {
  callback();
  return input.text;
}
std::string owningEntry(Payload input, Callback callback) {
  return borrowedBody(input, std::move(callback));
}
std::string thunk(void*, Payload input, Callback callback) {
  return owningEntry(std::move(input), std::move(callback));
}
std::string replacement(void*, Payload input, Callback callback) {
  callback();
  return input.text + "!";
}

int main() {
  Payload visible("before");
  const Payload privateSlot("private");
  Callback reenter = [&] { visible.text = "after"; };
  Payload::copies = 0;
  assert(borrowedBody(privateSlot, reenter) == "private");
  assert(visible.text == "after" && Payload::copies == 0);

  visible.text = "before";
  Payload::copies = 0;
  assert(owningEntry(visible, reenter) == "before");
  assert(visible.text == "after" && Payload::copies == 1);

  gea::CallableObject<std::string(Payload, Callback)> callable{&thunk, nullptr};
  Payload::copies = 0;
  const auto matched = callable.callKnownBorrowed<&thunk, &borrowedBody>(privateSlot, reenter);
  assert(matched == "private" && Payload::copies == 0);

  callable = {&replacement, nullptr};
  Payload::copies = 0;
  const auto replaced = callable.callKnownBorrowed<&thunk, &borrowedBody>(privateSlot, reenter);
  assert(replaced == "private!" && Payload::copies == 1);
}
