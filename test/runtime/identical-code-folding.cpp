// Built by test/identical-code-folding.mjs with a linker told to fold every
// identical function (lld-link /OPT:ICF, lld --icf=all, ld64's default
// deduplication), address-taken ones included, and run.
//
// Each pair below is two functions with one machine-code body that the
// runtime must still tell apart: two classes' unbound-method adapters whose
// receiver checks differ, two declarations' thunks with different names and
// construct entries, one entry under two argument frames. Folding gives each
// pair one address, so a runtime that found any of these facts by entry
// address answered with the other one's (the receiver case is how
// node-compat's stream overlays failed on Windows). It prints how many pairs
// the linker really folded, so the driver can tell a vacuous run from a pass.
#include "gea_runtime.h"
#include <cstdio>
#include <cstdlib>
#include <string_view>

namespace {
int failures = 0;
void check(bool ok, const char* what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
  if (!ok) ++failures;
}

// Two classes with one layout: their methods compile to one body.
struct First {
  static constexpr bool gea_traceLeaf = true;
  double value = 1;
};
struct Second {
  static constexpr bool gea_traceLeaf = true;
  double value = 1;
};

double readFirst(void*, gea::Ref<First> self, double extra) { return self ? self->value + extra : -1000 + extra; }
double readSecond(void*, gea::Ref<Second> self, double extra) { return self ? self->value + extra : -1000 + extra; }

// Two declarations with one body and different facts.
double alpha(void*, double value) { return value * 3 + 1; }
double beta(void*, double value) { return value * 3 + 1; }

// Two capture-free declarations told apart only by their declaration tags.
inline constexpr char alphaTag = 0;
inline constexpr char betaTag = 0;

using Pack = gea::Ref<gea::ArrayObject<double>>;
using Packed = gea::CallableObject<double(Pack)>;
double count(void*, Pack arguments) { return arguments ? arguments->length() : -1; }
double scale(void*, double value) { return value * 5; }

// Receiver resolvers for a method whose receiver is carried as a number: each
// checks its own class, and both answer 0 for a detached call, so the two
// adapters' detached entries compile to one body.
double readValue(void*, double self, double extra) { return self + extra; }
struct ResolveFirst {
  [[gnu::always_inline]] double operator()(const gea::NativeCallReceiver& receiver) const {
    if (receiver.kind == gea::NativeCallReceiver::Kind::Undefined) return 0;
    if (!receiver.is<First>()) throw std::runtime_error("not a First");
    return receiver.as<First>()->value;
  }
};
struct ResolveSecond {
  [[gnu::always_inline]] double operator()(const gea::NativeCallReceiver& receiver) const {
    if (receiver.kind == gea::NativeCallReceiver::Kind::Undefined) return 0;
    if (!receiver.is<Second>()) throw std::runtime_error("not a Second");
    return receiver.as<Second>()->value;
  }
};

template <typename T>
bool refuses(T work) {
  try {
    work();
  } catch (...) {
    return true;
  }
  return false;
}
}  // namespace

#if !defined(GEA_OLD_RUNTIME)
namespace {
using Call = gea::CallableObject<double(double)>;
using Constructor = gea::CallableConstructorObject<double(double), gea::Ref<First>(double)>;
double callUp(void*, double value) { return value + 7; }
double callDown(void*, double value) { return value + 7; }
gea::Ref<First> constructUp(void*, double value) {
  auto made = gea::makeRef<First>();
  made->value = value;
  return made;
}
gea::Ref<First> constructDown(void*, double value) {
  auto made = gea::makeRef<First>();
  made->value = -value;
  return made;
}
}  // namespace
#endif

int main() {
  using Plain = gea::CallableObject<double(double)>;
  int folded = 0;
  // Comparing entry addresses is how this test sees what the linker did; the
  // runtime itself must not depend on the answer.
  // Through volatile, so the compiler cannot answer from the declarations.
  const auto same = [&](auto left, auto right) {
    const void* volatile leftAddress = reinterpret_cast<const void*>(left);
    const void* volatile rightAddress = reinterpret_cast<const void*>(right);
    if (leftAddress == rightAddress) ++folded;
  };

  // Function facts: `name` and source text of two folded thunks.
  Plain a{Plain::entryWithFacts<&alpha>("alpha", 1, "function alpha(value) { return value * 3 + 1 }"), nullptr};
  Plain b{Plain::entryWithFacts<&beta>("beta", 1, "function beta(value) { return value * 3 + 1 }"), nullptr};
  same(&alpha, &beta);
  check(a.name() == "alpha" && b.name() == "beta", "folded thunks keep their own names");
  check(a.sourceText().find("alpha") != std::string_view::npos && b.sourceText().find("beta") != std::string_view::npos,
        "folded thunks keep their own source text");
  check(a.call(2) == 7 && b.call(2) == 7, "folded thunks still compute");

  // Argument frames: one entry under two frames, whose wrappers fold.
  const auto actual = Packed::entryWithArgumentFrame<&count, 0, true, false>();
  const auto suffix = Packed::entryWithArgumentFrame<&count, 0, false, false>();
  same(&Packed::callArgumentFrame<&count, 0, true, false>, &Packed::callArgumentFrame<&count, 0, false, false>);
  const auto actualBox = gea::Value::box(gea::Value::Tag::Function, Packed{actual, nullptr});
  const auto suffixBox = gea::Value::box(gea::Value::Tag::Function, Packed{suffix, nullptr});
  check(actualBox.actualArguments() && actualBox.restFrom() == 0, "an actual-arguments frame stays its own");
  check(!suffixBox.actualArguments() && suffixBox.restFrom() == 0, "a rest frame stays its own");
  // The same entry as a method (receiver in its first slot) and as a plain
  // function: two wrappers that are one jump to `scale`.
  const Plain method{Plain::entryWithArgumentFrame<&scale, -1, false, true>(), nullptr};
  const Plain plain{Plain::entryWithArgumentFrame<&scale, -1, false, false>(), nullptr};
  same(&Plain::callArgumentFrame<&scale, -1, false, true>, &Plain::callArgumentFrame<&scale, -1, false, false>);
  check(method.argumentFrame().receivesThis && !plain.argumentFrame().receivesThis && method.call(2) == 10 && plain.call(2) == 10,
        "a method frame and a plain frame stay their own");

  // Declaration identity: two capture-free functions are two function objects.
  const auto alphaValue = gea::identifyCallable<&alphaTag>(Plain{&alpha, nullptr});
  const auto betaValue = gea::identifyCallable<&betaTag>(Plain{&beta, nullptr});
  const auto alphaBox = gea::Value::box(gea::Value::Tag::Function, alphaValue);
  check(!gea::Value::strictEqualsCallable(alphaBox, betaValue), "two declarations with one body are not ===");
  check(gea::Value::strictEqualsCallable(alphaBox, gea::identifyCallable<&alphaTag>(Plain{&alpha, nullptr})),
        "one capture-free declaration is === itself");

  // Identity tags and class tables stay distinct (a linker folding read-only
  // data would merge every one of these zero bytes and identical tables).
  check(gea::detail::payloadTypeTagFor<gea::Ref<First>>() != gea::detail::payloadTypeTagFor<gea::Ref<Second>>(),
        "payload type tags stay distinct");
  check(static_cast<const void*>(&gea::detail::RefOperationsFor<First>::table) !=
            static_cast<const void*>(&gea::detail::RefOperationsFor<Second>::table),
        "class tables stay distinct");
  check(static_cast<const void*>(&gea::detail::RefOperationsFor<First>::table) !=
            static_cast<const void*>(&gea::detail::PlainObjectOperationsFor<First>::table),
        "a class table and its plain-object twin stay distinct");
  check(static_cast<const void*>(&gea::nativeClassMethodDeclaration<First>) !=
            static_cast<const void*>(&gea::nativeClassMethodDeclaration<Second>),
        "native class declaration tags stay distinct");

#if !defined(GEA_OLD_RUNTIME)
  // [[Construct]] entries of two declarations whose [[Call]] thunks fold.
  Call up{Call::entryWithConstruct<&callUp, &constructUp>(&callUp), nullptr};
  Call down{Call::entryWithConstruct<&callDown, &constructDown>(&callDown), nullptr};
  same(&callUp, &callDown);
  check(gea::withConstructEntry<Constructor>(up).construct(2)->value == 2 &&
            gea::withConstructEntry<Constructor>(down).construct(2)->value == -2,
        "folded call thunks keep their own construct entries");

#endif

  // Receivers: two classes' unbound-method adapters fold (one body), while
  // their receiver checks differ. Each must check its own class.
  using Unbound = gea::CallableObject<double(double)>;
  const gea::CallableObject<double(gea::Ref<First>, double)> firstMethod{&readFirst, nullptr};
  const gea::CallableObject<double(gea::Ref<Second>, double)> secondMethod{&readSecond, nullptr};
  const auto firstUnbound = Unbound::unboundMethod<First>(firstMethod);
  const auto secondUnbound = Unbound::unboundMethod<Second>(secondMethod);
  same(&Unbound::callUnboundMethod<First>, &Unbound::callUnboundMethod<Second>);
  auto firstObject = gea::makeRef<First>();
  firstObject->value = 10;
  auto secondObject = gea::makeRef<Second>();
  secondObject->value = 20;
  check(firstUnbound.callWithReceiver(gea::NativeCallReceiver::object(firstObject), 1) == 11, "a First method accepts a First");
  check(secondUnbound.callWithReceiver(gea::NativeCallReceiver::object(secondObject), 1) == 21, "a Second method accepts a Second");
  check(refuses([&] { (void)firstUnbound.callWithReceiver(gea::NativeCallReceiver::object(secondObject), 1); }),
        "a First method refuses a Second");
  check(refuses([&] { (void)secondUnbound.callWithReceiver(gea::NativeCallReceiver::object(firstObject), 1); }),
        "a Second method refuses a First");
  check(firstUnbound.call(1) == -999, "a detached call still runs the body");

  // The same, for receivers a certified resolver reads (`unboundMethodAs`).
  const gea::CallableObject<double(double, double)> valueMethod{&readValue, nullptr};
  const auto firstValue = Unbound::unboundMethodAs<double>(valueMethod, ResolveFirst{});
  const auto secondValue = Unbound::unboundMethodAs<double>(valueMethod, ResolveSecond{});
  same(&Unbound::callUnboundMethodAs<double, ResolveFirst>, &Unbound::callUnboundMethodAs<double, ResolveSecond>);
  check(firstValue.callWithReceiver(gea::NativeCallReceiver::object(firstObject), 1) == 11 &&
            secondValue.callWithReceiver(gea::NativeCallReceiver::object(secondObject), 1) == 21,
        "resolved methods accept their own class");
  check(refuses([&] { (void)firstValue.callWithReceiver(gea::NativeCallReceiver::object(secondObject), 1); }) &&
            refuses([&] { (void)secondValue.callWithReceiver(gea::NativeCallReceiver::object(firstObject), 1); }),
        "resolved methods refuse the other class");
  check(firstValue.call(1) == 1 && secondValue.call(1) == 1, "resolved detached calls still run the body");

  std::printf("folded %d\n", folded);
  std::printf("%s\n", failures == 0 ? "identical-code-folding: passed" : "identical-code-folding: FAILED");
  return failures == 0 ? 0 : 1;
}
