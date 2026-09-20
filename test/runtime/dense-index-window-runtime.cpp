#include "gea_runtime.h"
#include <cassert>

int main() {
  for (std::size_t size = 0; size < 20; ++size)
    for (int seed = -2; seed < 5; ++seed)
      for (int base = -3; base < 4; ++base)
        for (int bound = 0; bound < 9; ++bound)
          for (int step = 0; step < 4; ++step)
            for (bool inclusive : {false, true})
              for (bool widened : {false, true}) {
                if (!gea::denseIndexWindow(size, seed, base, bound, step, inclusive, widened)) continue;
                for (int i = seed, turns = 0; (inclusive ? i <= bound : i < bound) && turns < 30; i += step, ++turns) {
                  const auto index = base + i + (widened ? step : 0);
                  assert(index >= 0 && static_cast<std::size_t>(index) < size);
                }
              }
  for (double invalid : {0.5, -0.5, std::numeric_limits<double>::infinity(),
                         -std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN(), 1e30}) {
    assert(!gea::denseIndexWindow(100, invalid, 0, 10, 1, false, false));
    assert(!gea::denseIndexWindow(100, 0, invalid, 10, 1, false, false));
    assert(!gea::denseIndexWindow(100, 0, 0, invalid, 1, false, false));
    assert(!gea::denseIndexWindow(100, 0, 0, 10, invalid, false, false));
  }
  constexpr double max = 9007199254740991.0;
  assert(!gea::denseIndexWindow(100, max, max, max, max, true, true));
  assert(!gea::denseIndexWindow(100, -max, -max, max, max, true, true));
  assert(gea::denseIndexWindow(4, 0, 0, 4, 1, false, false));
  assert(!gea::denseIndexWindow(3, 0, 0, 4, 1, false, false));
}
