#include "gea_runtime.h"
#include <cassert>
#include <cstdlib>

static bool counting = false;
static unsigned allocations = 0;
void* operator new(std::size_t n) {
  if (counting) ++allocations;
  if (auto* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

int main(int argc, char**) {
  using gea::detail::HostNumericArgument;
  auto array = gea::makeRef<gea::ArrayObject<double>>();
  array->push(1.25); array->push(4294967295.0); array->push(-1.0);
  if (argc > 1) {
    array->setLength(4);
    HostNumericArgument<float> sparse(array);
    return 3;
  }
  counting = true;
  HostNumericArgument<std::int32_t> integers(array);
  counting = false;
  assert(allocations == 0 && integers.data()[0] == 1 && integers.data()[1] == -1 && integers.data()[2] == -1);
  array->setElement(0, 99.0);
  assert(integers.data()[0] == 1); // Ordinary array snapshot is independent.
  auto typed = gea::makeRef<gea::TypedArray<float>>(32);
  typed->setElement(3, 42.5);
  auto offset = gea::TypedArray<float>::fromBuffer(typed->buffer(), 3 * sizeof(float), 4);
  counting = true;
  HostNumericArgument<float> borrowed(offset);
  counting = false;
  assert(allocations == 0 && borrowed.data() == offset.data() && borrowed.size() == 4 && borrowed.data()[0] == 42.5f);
  auto moved = std::move(borrowed);
  assert(moved.data()[0] == 42.5f);
  using Source = gea::TaggedUnion<gea::Undefined, decltype(typed), decltype(array)>;
  const auto unionSource = Source::ofArm<1>(typed);
  HostNumericArgument<float> unionView(unionSource);
  assert(unionView.data() == typed->data() && unionView.data()[3] == 42.5f);
  HostNumericArgument<float> missing(gea::Optional<Source>{});
  assert(missing.empty());
  for (int i = 0; i < 100; ++i) array->push(double(i));
  allocations = 0; counting = true;
  HostNumericArgument<float> large(array);
  counting = false;
  assert(allocations == 1 && large.size() == 103 && large.data()[102] == 99.0f);
  auto copied = large;
  assert(copied.data() != large.data() && copied.data()[102] == 99.0f);
  auto shared = gea::makeRef<gea::SharedArrayBuffer>(32);
  auto sharedView = gea::TypedArray<float>::fromSharedBuffer(shared, 0, 8);
  sharedView.setElement(0, 15.0);
  HostNumericArgument<float> synchronized(sharedView);
  sharedView.setElement(0, 16.0);
  assert(synchronized.data() != sharedView.data() && synchronized.data()[0] == 15.0f);
}
