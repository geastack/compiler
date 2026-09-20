#include "gea_runtime.h"
#include <cassert>

struct Geometry final { int value = 7; };
struct Base {
  gea::Ref<Geometry> geometry = gea::makeRef<Geometry>();
  bool present = true;
  virtual bool gea_readOwnFieldNative(const gea::PropertyKey& key, gea::NativeFieldRead& read) const {
    if (key == gea::PropertyKey::string("geometry")) return present && read.assign(geometry);
    return false;
  }
  virtual ~Base() = default;
};
struct Derived final : Base {
  gea::Ref<Geometry> own = gea::makeRef<Geometry>();
  bool gea_readOwnFieldNative(const gea::PropertyKey& key, gea::NativeFieldRead& read) const override {
    if (key == gea::PropertyKey::string("geometry")) return present && read.assign(own);
    return Base::gea_readOwnFieldNative(key, read);
  }
};
struct Accessor final : Base {
  mutable int calls = 0;
  bool gea_readOwnFieldNative(const gea::PropertyKey& key, gea::NativeFieldRead& read) const override {
    if (key == gea::PropertyKey::string("geometry")) return false;
    return Base::gea_readOwnFieldNative(key, read);
  }
  gea::Ref<Geometry> get() const { ++calls; return geometry; }
};

int main() {
  auto derived = gea::makeRef<Derived>();
  gea::Ref<Base> base = derived;
  const auto key = gea::PropertyKey::string("geometry");
  int fallbacks = 0;
  const auto before = gea::detail::allocationProfile().created;
  for (int i = 0; i < 10000; ++i) {
    auto result = gea::nativeFieldGet<gea::Ref<Geometry>>(base, key, [&] {
      ++fallbacks;
      return gea::Ref<Geometry>{};
    });
    assert(result.get() == derived->own.get());
  }
  assert(fallbacks == 0 && gea::detail::allocationProfile().created == before);
  derived->present = false;
  assert(!gea::nativeFieldGet<gea::Ref<Geometry>>(base, key, [&] { ++fallbacks; return gea::Ref<Geometry>{}; }));
  assert(fallbacks == 1); // A deleted derived slot must not expose the base slot.
  derived->present = true;
  assert(gea::nativeFieldGet<double>(base, key, [&] { ++fallbacks; return 3.0; }) == 3.0);
  assert(fallbacks == 2); // A mismatched result type never writes through the erased pointer.
  auto accessor = gea::makeRef<Accessor>();
  base = accessor;
  auto result = gea::nativeFieldGet<gea::Ref<Geometry>>(base, key, [&] { return accessor->get(); });
  assert(result.get() == accessor->geometry.get() && accessor->calls == 1);
  base = nullptr;
  assert(gea::nativeFieldGet<int>(base, key, [] { return 9; }) == 9);
}
