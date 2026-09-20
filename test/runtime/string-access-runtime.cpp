#include "gea_runtime.h"
#include <cassert>
#include <cmath>

int main() {
  // Every short length and byte position, including the overlapping-load
  // boundaries, must classify exactly; byte values cover NUL and high bits.
  for (std::size_t length = 0; length <= 10; ++length) {
    std::string text(length, 'x');
    assert(gea::runtime::string::isShortBasicLatin(text) == (length <= 8));
    for (std::size_t index = 0; index < length; ++index) {
      for (unsigned byte = 0; byte < 256; ++byte) {
        text[index] = static_cast<char>(byte);
        assert(gea::runtime::string::isShortBasicLatin(text) == (length <= 8 && byte < 128));
      }
      text[index] = 'x';
    }
  }

  using namespace gea::runtime::string;
  const CodeUnit absent{};
  assert(!(absent == absent) && absent != absent);
  assert(!(absent == 65536) && !(absent == std::numeric_limits<double>::quiet_NaN()));
  for (std::uint32_t code : {0u, 127u, 233u, 65533u, 65535u}) {
    const CodeUnit value{code};
    assert(value == code && code == value && value == value);
    assert(value != static_cast<double>(code) + 0.5);
    assert(static_cast<double>(value) == code);
  }
  // Same allocation, size and prefix; only the suffix changes UTF-16 length.
  std::string reused = "abcdefghij";
  assert(utf16Length(reused) == 10);
  reused[8] = '\xc3'; reused[9] = '\xa9';
  assert(utf16Length(reused) == 9);
  assert(charCodeAt(reused, 8) == 233);
  assert(std::isnan(charCodeAt(reused, 9)));
  reused[8] = 'i'; reused[9] = 'j';
  assert(utf16Length(reused) == 10);
  assert(charCodeAt(reused, 9) == 'j');

  for (const std::string text : {std::string(), std::string("ascii"), std::string("a\xc3\xa9\xf0\x9f\x98\x80z"), std::string("\xed\xa0\x80")}) {
    auto metadata = utf16Metadata(text);
    // Sequential, backward, repeated, fractional and out-of-range reads.
    for (double index : {0., 1., 2., 3., 4., 2., 1., -1., -0.5, 0.5, 100.,
        std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
      const double expected = charCodeAt(text, index);
      const double actual = charCodeAtWithMetadata(text, index, metadata.units, metadata.basicLatin, metadata.cursor);
      assert((std::isnan(expected) && std::isnan(actual)) || expected == actual);
    }
    for (long long index = -1; index <= static_cast<long long>(metadata.units); ++index) {
      const double expected = charCodeAt(text, static_cast<double>(index));
      const double actual = charCodeAtWithMetadata(text, index, metadata.units, metadata.basicLatin, metadata.cursor);
      assert((std::isnan(expected) && std::isnan(actual)) || expected == actual);
    }
  }
}
