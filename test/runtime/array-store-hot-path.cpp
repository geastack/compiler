#include "gea_runtime.h"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <string_view>

using Numbers = gea::ArrayObject<double>;

static void stores(bool integerKeys) {
  Numbers a;
  auto set = [&](int index, double value) {
    if (integerKeys) a.setElementAtIndex(index, value);
    else a.setElement(index, value);
  };
  set(0, 11);
  set(1, 22);
  set(4, 55);
  assert(a.size() == 5 && !a.present(2) && !a.present(3));
  set(2, 33);
  assert(a.present(2) && a.elementAt(2) == 33 && !a.present(3));
  a.pushUndefined();
  assert(a.present(5) && a.elementIsUndefined(5));
  set(5, 66);
  assert(!a.elementIsUndefined(5) && a.elementAt(5) == 66);
  a.pushUndefined();
  set(9, 100);
  assert(a.present(6) && a.elementIsUndefined(6));
  assert(!a.present(7) && !a.present(8));
  set(10, 110);
  assert(a.elementAt(0) == 11 && a.elementAt(10) == 110);
  assert(a.holes.size() <= a.size() && a.undefineds.size() <= a.size());
  gea::ArrayObject<std::string> strings;
  strings.push("one");
  const auto copied = strings.elementAt(0);
  strings.setElement(20, copied);
  assert(strings.elementAt(20) == "one");
}

static void aliases(bool integerKeys) {
  gea::ArrayObject<std::string> strings;
  strings.push(std::string(128, 'x'));
  if (integerKeys) strings.setElementAtIndex(100, strings.elementAt(0));
  else strings.setElement(100, strings.elementAt(0));
  assert(strings.elementAt(100) == std::string(128, 'x'));
  auto object = gea::makeRef<double>(42);
  gea::ArrayObject<gea::Ref<double>> objects;
  objects.push(object);
  if (integerKeys) objects.setElementAtIndex(100, objects.elementAt(0));
  else objects.setElement(100, objects.elementAt(0));
  assert(objects.elementAt(100).get() == object.get());
  assert(*objects.elementAt(100) == 42);
}

// Fixed scalar indices match ordinary unrolled numerical code emitted by the
// compiler. The receiver and its length remain unknown at the call boundary.
[[gnu::noinline]] static double update(Numbers& a, double x) {
  a.setElement(0, x); a.setElement(1, x + 1); a.setElement(2, x + 2); a.setElement(3, 0);
  a.setElement(4, x + 4); a.setElement(5, x + 5); a.setElement(6, x + 6); a.setElement(7, 0);
  a.setElement(8, x + 8); a.setElement(9, x + 9); a.setElement(10, x + 10); a.setElement(11, 0);
  a.setElement(12, x + 12); a.setElement(13, x + 13); a.setElement(14, x + 14); a.setElement(15, 1);
  return a.elementAt(14);
}

[[gnu::noinline]] static void append(Numbers& a, int count) {
  for (int i = 0; i < count; ++i) a.setElementAtIndex(i, i);
}

int main(int argc, char** argv) {
  stores(false); stores(true);
  aliases(false); aliases(true);
  for (bool integerKeys : {false, true}) {
    for (int index : {0, 1, 9}) {
      Numbers a; a.reserve(4); a.push(1); a.freezeIntegrity();
      bool threw = false;
      try {
        if (integerKeys) a.setElementAtIndex(index, 2);
        else a.setElement(index, 2);
      } catch (const gea::Value& error) {
        threw = error.getProperty(gea::PropertyKey::string("name")).as<std::string>() == "TypeError";
      }
      assert(threw && a.size() == 1 && a.elementAt(0) == 1);
    }
  }
  if (argc > 1 && std::string_view(argv[1]) == "append") {
    constexpr int count = 1000000;
    Numbers a;
    a.reserve(count);
    for (int trial = 0; trial < 7; ++trial) {
      const auto begin = std::chrono::steady_clock::now();
      for (int round = 0; round < 10; ++round) {
        a.cells.clear();
        append(a, count);
      }
      const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
      std::printf("append trial=%d ms=%.6f checksum=%.0f\n", trial, ms, a.elementAt(count - 1));
    }
    return 0;
  }
  if (argc < 2 || std::string_view(argv[1]) != "benchmark") return 0;
  Numbers a;
  for (int i = 0; i < 16; ++i) a.push(i);
  constexpr int rounds = 3000000;
  for (int trial = 0; trial < 7; ++trial) {
    const auto begin = std::chrono::steady_clock::now();
    double sum = 0;
    for (int i = 0; i < rounds; ++i) sum += update(a, double(i & 1023));
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
    assert(sum > 0 && a.elementAt(15) == 1);
    std::printf("trial=%d rounds=%d ms=%.6f checksum=%.0f\n", trial, rounds, ms, sum);
  }
}
