#include "gea_runtime.h"
#include <cassert>
#include <bit>

void check(double value) {
  const auto limit = gea::kIntegerBoundLimit;
  assert(gea::integerBoundLess(value) == gea::integerBoundOf(std::ceil(value), -limit));
  assert(gea::integerBoundLessEqual(value) == gea::integerBoundOf(std::floor(value), -limit));
  assert(gea::integerBoundGreater(value) == gea::integerBoundOf(std::floor(value), limit));
  assert(gea::integerBoundGreaterEqual(value) == gea::integerBoundOf(std::ceil(value), limit));
  const bool safe = std::isfinite(value) && std::trunc(value) == value && std::fabs(value) <= 9007199254740991.0;
  assert(gea::host::NumberConstructor::isSafeInteger(value) == safe);
}

int main() {
  for (double value : {0., -0., 0.1, -0.1, 1.5, -1.5, 9007199254740991., 9007199254740992.,
                       gea::kIntegerBoundLimit, -gea::kIntegerBoundLimit,
                       std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(),
                       std::numeric_limits<double>::quiet_NaN()}) {
    check(value);
    check(std::nextafter(value, -std::numeric_limits<double>::infinity()));
    check(std::nextafter(value, std::numeric_limits<double>::infinity()));
  }
  // Include subnormals, signed fractions, NaN payloads, and very large finite
  // numbers without depending on a platform's random-number implementation.
  std::uint64_t bits = 0x3141592653589793ULL;
  for (int i = 0; i < 100000; ++i) {
    bits = bits * 6364136223846793005ULL + 1442695040888963407ULL;
    check(std::bit_cast<double>(bits));
  }
}
