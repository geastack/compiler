#include "gea_runtime.h"
#include <cassert>
#include <cstdlib>

static bool countAllocations = false;
static std::size_t allocations = 0;
void* operator new(std::size_t size) {
  if (countAllocations) ++allocations;
  if (void* memory = std::malloc(size ? size : 1)) return memory;
  throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }

static double consume(std::span<const double> values) {
  double sum = 0;
  for (double value : values) sum += value;
  return sum;
}

int main(int argc, char**) {
  if (argc > 1) {
    auto sparse = gea::makeRef<gea::ArrayObject<double>>();
    sparse->push(1.0);
    sparse->setLength(2);
    (void)gea::detail::hostArraySnapshotArgument(sparse);
    return 3;
  }
  for (int size : {0, 1, 9, 16, 17, 1024}) {
    auto source = gea::makeRef<gea::ArrayObject<double>>();
    for (int i = 0; i < size; ++i) source->push(double(i));
    (void)gea::detail::hostArraySnapshotArgument(source);
    allocations = 0;
    countAllocations = true;
    double sum = 0;
    for (int i = 0; i < 1000; ++i) sum += consume(gea::detail::hostArraySnapshotArgument(source));
    countAllocations = false;
    assert(sum == 1000.0 * size * (size - 1) / 2);
    assert(allocations == (size <= 16 ? 0 : 1000));
  }
}
