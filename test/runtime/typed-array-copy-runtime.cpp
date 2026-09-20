#include "gea_runtime.h"
#include <cassert>
#include <cstring>

int main() {
  for (double number : {0., -0., 7., 4294967294., 4294967295., -1., 1.5}) {
    const auto numeric = gea::PropertyKey::number(number);
    const auto named = gea::PropertyKey::string(gea::host::detail::toString(number));
    assert(numeric == named);
    assert(numeric.text() == named.text());
  }
  const double numbers[] = {0, -0.0, 1.9, -1.9, 255, 256, -257, 65536, 4294967295.0,
      4294967296.0, -4294967297.0, 9223372036854775808.0, -9223372036854775808.0,
      1e300, -1e300, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()};
  for (double modulus : {256.0, 65536.0, 4294967296.0}) {
    for (double value : numbers) {
      double expected = std::isfinite(value) ? std::fmod(std::trunc(value), modulus) : 0;
      if (expected < 0) expected += modulus;
      assert(gea::detail::typedArrayIntegerModulo(value, modulus) == expected);
    }
  }
  gea::TypedArray<std::uint8_t> bytes(6);
  for (std::size_t i = 0; i < bytes.size(); ++i) bytes.setElement(i, i + 1);
  bytes.setFrom(*bytes.subarray(0, 4), 1);
  const std::uint8_t forward[] = {1, 1, 2, 3, 4, 6};
  assert(std::memcmp(bytes.data(), forward, sizeof forward) == 0);
  bytes.setFrom(*bytes.subarray(1, 5), 0);
  const std::uint8_t backward[] = {1, 2, 3, 4, 4, 6};
  assert(std::memcmp(bytes.data(), backward, sizeof backward) == 0);
  for (double invalid : {-1., 0.5, 6., 1e300,
       std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(),
       std::numeric_limits<double>::quiet_NaN()}) {
    assert(!bytes.hasElement(invalid));
    bytes.setElement(invalid, 99);
    assert(std::memcmp(bytes.data(), backward, sizeof backward) == 0);
  }
  assert(bytes.hasElement(-0.0) && bytes.hasElement(5));
  bytes.setFrom(bytes, 0);
  assert(std::memcmp(bytes.data(), backward, sizeof backward) == 0);
  bytes.setFrom(gea::TypedArray<std::uint8_t>(0), 6);

  // Float-to-float copies preserve payload bits and the sign of zero.
  gea::TypedArray<float> floats(2), copy(2);
  const std::uint32_t bits[] = {0x7fc12345u, 0x80000000u};
  std::memcpy(floats.data(), bits, sizeof bits);
  copy.setFrom(floats, 0);
  assert(std::memcmp(copy.data(), bits, sizeof bits) == 0);

  // Different domains still convert, snapshotting overlapping byte storage.
  auto source = gea::TypedArray<std::uint16_t>::fromBuffer(bytes.buffer(), 0, 3);
  source.setElement(0, 257);
  source.setElement(1, 258);
  source.setElement(2, 259);
  bytes.setFrom(source, 1);
  assert(bytes.elementAt(1) == 1 && bytes.elementAt(2) == 2 && bytes.elementAt(3) == 3);
}
