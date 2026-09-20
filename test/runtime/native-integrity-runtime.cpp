#include "gea_runtime.h"
#include <cassert>
#include <chrono>

struct Point {
  double x = 0, y = 0, z = 0;
};

// Keep the call boundary that separately emitted application modules use.
[[gnu::noinline]] static double update(const gea::Ref<Point>& point, double delta) {
  if (gea::nativeOwnFieldsWritable(point)) point->x += delta;
  if (gea::nativeOwnFieldsWritable(point)) point->y += delta;
  if (gea::nativeOwnFieldsWritable(point)) point->z += delta;
  return point->x + point->y + point->z;
}

static void benchmark() {
  using Clock = std::chrono::steady_clock;
  std::vector<gea::Ref<Point>> points;
  std::vector<gea::Ref<Point>> frozen;
  for (int i = 0; i < 4096; ++i) points.push_back(gea::makeRef<Point>());
  for (const int count : {0, 1, 16, 256, 4096}) {
    while (frozen.size() < static_cast<std::size_t>(count)) {
      auto point = gea::makeRef<Point>();
      gea::nativeFreeze(point);
      frozen.push_back(std::move(point));
    }
    for (int sample = 0; sample < 5; ++sample) {
      const auto start = Clock::now();
      double checksum = 0;
      for (std::size_t i = 0; i < 4000000; ++i) checksum += update(points[(i * 17) % points.size()], 1);
      const auto elapsed = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
      std::printf("sidecars=%d sample=%d ms=%.3f checksum=%.0f\n", count, sample, elapsed, checksum);
    }
  }
}

static void integrity() {
  auto point = gea::makeRef<Point>();
  assert(gea::nativeOwnFieldsWritable(point) && gea::nativeIsExtensible(point));
  assert(!gea::nativeIsFrozen(point));
  auto alias = point;
  gea::nativeFreeze(point);
  assert(gea::nativeIsFrozen(alias));
  assert(!gea::nativeOwnFieldsWritable(alias) && !gea::nativeIsExtensible(alias));
  assert(update(alias, 1) == 0);

  // Growth must preserve the identity and integrity of existing entries.
  std::vector<gea::Ref<Point>> owners;
  for (int i = 0; i < 4096; ++i) {
    auto owner = gea::makeRef<Point>();
    gea::nativeFreeze(owner);
    owners.push_back(std::move(owner));
  }
  assert(gea::nativeIsFrozen(alias) && !gea::nativeOwnFieldsWritable(alias));
  for (const auto& owner : owners) assert(gea::nativeIsFrozen(owner));

  // A retained weak owner distinguishes an expired sidecar from a live one.
  const auto* address = point.get();
  point = nullptr;
  alias = nullptr;
  assert(gea::detail::findNativeExpando(address) == nullptr);
  auto fresh = gea::makeRef<Point>();
  assert(gea::nativeOwnFieldsWritable(fresh) && gea::nativeIsExtensible(fresh));
  assert(update(fresh, 2) == 6);
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string_view(argv[1]) == "--benchmark") benchmark();
  else integrity();
}
