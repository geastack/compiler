#include "gea_runtime.h"
#include <cassert>
#include <cmath>

// This runs at -O3 with strict aliasing enabled as well as under sanitizers.
// A loop range proof says nothing about overlap between its array operands.
[[gnu::noinline]] double mixed(std::uint32_t* words, float* floats, std::size_t count) {
  double sum = 0;
  for (std::size_t i = 0; i < count; ++i) {
    gea::TypedArray<std::uint32_t>::writeInBounds(words, i, 1065353216);
    sum += gea::TypedArray<float>::readInBounds(floats, i);
    gea::TypedArray<float>::writeInBounds(floats, i, 2);
  }
  return sum;
}

template <typename T>
void conversions() {
  gea::TypedArray<T> checked(1), unchecked(1);
  for (double value : {-1e30, -257., -0.0, 0.5, 1.5, 2.5, 255.5, 256., 65536., 1e30,
                       std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
    checked.setElement(0, value);
    gea::TypedArray<T>::writeInBounds(unchecked.data(), 0, value);
    const double expected = checked.elementAt(0);
    const double actual = static_cast<double>(gea::TypedArray<T>::readInBounds(unchecked.data(), 0));
    assert((std::isnan(expected) && std::isnan(actual)) ||
           (expected == actual && std::signbit(expected) == std::signbit(actual)));
  }
}

int main() {
  gea::TypedArray<std::uint8_t> bytes(64);
  auto words = gea::TypedArray<std::uint32_t>::fromBuffer(bytes.buffer(), 0, 16);
  auto floats = gea::TypedArray<float>::fromBuffer(bytes.buffer(), 0, 16);
  assert(mixed(words.data(), floats.data(), 16) == 16);
  for (std::size_t i = 0; i < 16; ++i) assert(floats.elementAt(i) == 2);
  auto source = gea::TypedArray<std::uint8_t>::fromBuffer(bytes.buffer(), 0, 8);
  auto target = gea::TypedArray<std::uint8_t>::fromBuffer(bytes.buffer(), 1, 8);
  source.setElement(0, 0);
  for (std::size_t i = 0; i < 8; ++i)
    gea::TypedArray<std::uint8_t>::writeInBounds(target.data(), i,
      gea::TypedArray<std::uint8_t>::readInBounds(source.data(), i) + 1);
  for (std::size_t i = 0; i < 9; ++i) assert(bytes.elementAt(i) == i);
  conversions<std::int8_t>();
  conversions<std::uint8_t>();
  conversions<gea::ClampedUint8>();
  conversions<std::int16_t>();
  conversions<std::uint16_t>();
  conversions<std::int32_t>();
  conversions<std::uint32_t>();
  conversions<float>();
  conversions<double>();
}
