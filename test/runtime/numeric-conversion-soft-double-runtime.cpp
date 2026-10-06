// The GEA_SOFT_DOUBLE spelling of the integer bounds and the typed-array wrap
// (bits only, no double compare or conversion) must answer exactly what the
// arithmetic spelling does. Forced on here so a host with a double FPU checks
// the branch a core without one compiles.
#define GEA_SOFT_DOUBLE 1
#include "gea_runtime.h"
#include <bit>
#include <cassert>

static_assert(GEA_SOFT_DOUBLE == 1);

static std::uint64_t wrapReference(double value, std::uint64_t mask) {
  if (!std::isfinite(value)) return 0;
  const double modulus = static_cast<double>(mask) + 1.0;
  const double wrapped = std::fmod(std::trunc(value), modulus);
  return static_cast<std::uint64_t>(wrapped < 0.0 ? wrapped + modulus : wrapped);
}

static void check(double value) {
  const auto limit = gea::kIntegerBoundLimit;
  assert(gea::integerBoundLess(value) == gea::integerBoundOf(std::ceil(value), -limit));
  assert(gea::integerBoundLessEqual(value) == gea::integerBoundOf(std::floor(value), -limit));
  assert(gea::integerBoundGreater(value) == gea::integerBoundOf(std::floor(value), limit));
  assert(gea::integerBoundGreaterEqual(value) == gea::integerBoundOf(std::ceil(value), limit));
  for (std::uint64_t mask : {255ull, 65535ull, 4294967295ull})
    assert(gea::detail::typedArrayIntegerBits(value, mask) == wrapReference(value, mask));
  std::int64_t truncated;
  bool fractional;
  if (gea::detail::doubleBitsTruncate(value, truncated, fractional)) {
    assert(std::isfinite(value) && std::fabs(value) < 9223372036854775808.0);
    assert(static_cast<double>(truncated) == std::trunc(value));
    assert(fractional == (std::trunc(value) != value));
  } else {
    assert(!std::isfinite(value) || std::fabs(value) >= 9223372036854775808.0);
  }
}

int main() {
  for (double value : {0., -0., 0.1, -0.1, 0.9999999999999999, -0.9999999999999999, 1.5, -1.5, 255.5, -255.5,
                       4294967295., 4294967296., 4294967297.5, 9007199254740991., 9007199254740992.,
                       4611686018427387904., -4611686018427387904., 9223372036854775807., 9223372036854775808.,
                       -9223372036854775808., gea::kIntegerBoundLimit, -gea::kIntegerBoundLimit,
                       std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(),
                       std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::denorm_min()}) {
    check(value);
    check(std::nextafter(value, -std::numeric_limits<double>::infinity()));
    check(std::nextafter(value, std::numeric_limits<double>::infinity()));
  }
  std::uint64_t bits = 0x2718281828459045ULL;
  for (int i = 0; i < 200000; ++i) {
    bits = bits * 6364136223846793005ULL + 1442695040888963407ULL;
    check(std::bit_cast<double>(bits));
    // Concentrate on the magnitudes an index or a coordinate actually has.
    check(static_cast<double>(static_cast<std::int64_t>(bits >> 20)) / static_cast<double>(1 << (bits & 15)));
  }

  gea::ArrayObject<double> array;
  for (int i = 0; i < 4; ++i) array.push(i * 1.5);
  assert(array.elementAtIndex(2) == 3.0);
  array.setElementAtIndex(1, 9.0);
  array.setElementAtIndex(4, 7.0);  // the append at length
  assert(array.size() == 5 && array.elementAtIndex(4) == 7.0 && array.elementAtIndex(1) == 9.0);
  array.setElementAtIndex(8, 2.0);  // past the end opens a gap
  assert(array.size() == 9 && !array.hasElementAtIndex(6) && array.hasElementAtIndex(8));
  assert(!array.hasElementAtIndex(-1) && !array.hasElementAtIndex(9));
  assert(!array.hasElementAtIndex((1ll << 32) + 1));
  assert(!array.hasElementValueAtIndex((1ll << 32) + 1));
}
