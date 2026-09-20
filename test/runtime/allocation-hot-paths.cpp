#include "gea_runtime.h"
#include <cassert>

struct NativeState { double value = 0; };

static void nullishAndSidecars() {
  const auto before = gea::detail::allocationProfile().created;
  for (int i = 0; i < 10000; ++i) {
    auto value = gea::Value::box(gea::Value::Tag::Undefined, gea::Undefined{});
    auto copy = value;
    assert(gea::Value::strictEquals(copy, gea::Value()));
    (void)gea::detail::unboxAs<gea::Undefined>(copy, gea::Value::Tag::Undefined, "undefined");
    auto null = gea::Value::box(gea::Value::Tag::Null, nullptr);
    assert(gea::detail::unboxAs<std::nullptr_t>(null, gea::Value::Tag::Null, "null") == nullptr);
    assert(!gea::Value::strictEquals(null, value));
  }
  assert(gea::detail::allocationProfile().created == before);
  auto object = gea::makeRef<NativeState>();
  const auto key = gea::PropertyKey::string("attributesNum");
  assert(gea::nativeDynamicSet(object, key, gea::Value::box(gea::Value::Tag::Number, 1.0)));
  const auto initialized = gea::detail::allocationProfile().created;
  for (int i = 0; i < 10000; ++i) {
    assert(gea::nativeDynamicSet(object, key, gea::Value::box(gea::Value::Tag::Number, double(i))));
    assert(gea::nativeDynamicGet(object, key).as<double>() == i);
  }
  assert(gea::detail::allocationProfile().created == initialized);
  int gets = 0, sets = 0;
  gea::PropertyDescriptor accessor;
  accessor.hasGet = accessor.hasSet = true;
  accessor.get = [&](const gea::Value& receiver) {
    ++gets;
    assert(receiver.as<gea::Ref<NativeState>>().get() == object.get());
    return gea::Value::box(gea::Value::Tag::Number, object->value);
  };
  accessor.set = [&](const gea::Value& receiver, const gea::Value& written) {
    ++sets;
    assert(receiver.as<gea::Ref<NativeState>>().get() == object.get());
    object->value = written.as<double>();
  };
  assert(gea::nativeDynamicDefineProperty(object, key, accessor));
  assert(gea::nativeDynamicSet(object, key, gea::Value::box(gea::Value::Tag::Number, 42.0)));
  assert(gea::nativeDynamicGet(object, key).as<double>() == 42 && gets == 1 && sets == 1);
  const auto table = gea::detail::expandoFor(gea::refCastToVoid(object), false);
  assert(table->deleteOwnProperty(key));
  gea::PropertyDescriptor frozen;
  frozen.hasValue = true; frozen.value = gea::Value::box(gea::Value::Tag::Number, 7.0);
  assert(gea::nativeDynamicDefineProperty(object, key, frozen));
  assert(!gea::nativeDynamicSet(object, key, gea::Value::box(gea::Value::Tag::Number, 8.0)));
  assert(gea::nativeDynamicGet(object, key).as<double>() == 7);
}

static void snapshots() {
  for (int count : {0, 1, 9, 16, 17, 1024}) {
    auto array = gea::makeRef<gea::ArrayObject<double>>();
    for (int i = 0; i < count; ++i) array->push(double(i));
    auto snapshot = gea::detail::hostArraySnapshotArgument(array);
    auto copy = snapshot;
    auto moved = std::move(snapshot);
    std::span<const double> view = moved;
    assert(view.size() == unsigned(count));
    if (count) array->cells[0].value = -1;
    for (int i = 0; i < count; ++i) assert(view[i] == i && copy[i] == i);
    std::vector<double> legacy = std::move(moved);
    assert(legacy.size() == unsigned(count));
    for (int i = 0; i < count; ++i) assert(legacy[i] == i);
  }
}

int main() { nullishAndSidecars(); snapshots(); }
