#include "gea_runtime.h"
#include <cassert>

struct Key {
  static inline unsigned copies = 0;
  gea::Ref<int> object;
  explicit Key(gea::Ref<int> value) : object(std::move(value)) {}
  Key(const Key& other) : object(other.object) { ++copies; }
  const void* get() const { return object.get(); }
};

int main() {
  Key first(gea::makeRef<int>(7)), second(gea::makeRef<int>(9));
  gea::WeakMap<Key, int> map;
  gea::WeakSet<Key> set;
  map.set(first, 1);
  set.add(first);
  assert(Key::copies == 2);
  for (int i = 0; i < 10000; ++i) {
    map.set(first, i);
    set.add(first);
    assert((*map.get(first)) == i && set.has(first));
  }
  assert(Key::copies == 2); // No temporary owning key on existing entries.
  map.set(second, 42);
  set.add(second);
  assert(Key::copies == 4 && (*map.get(second)) == 42);
  assert(map.remove(first) && set.remove(first));
  assert(!map.has(first) && !set.has(first));
  map.set(first, 11);
  set.add(first);
  assert(Key::copies == 6 && (*map.get(first)) == 11);

  std::vector<Key> many;
  for (int i = 0; i < 4096; ++i) many.emplace_back(gea::makeRef<int>(i));
  for (int i = 0; i < 4096; ++i) map.set(many[i], i);
  for (int i = 0; i < 4096; i += 2) assert(map.remove(many[i]));
  for (int i = 0; i < 4096; ++i) {
    assert(map.has(many[i]) == (i % 2 != 0));
    if (i % 2) assert(*map.get(many[i]) == i);
    else { assert(!map.get(many[i]).has_value()); map.set(many[i], -i); }
  }
}
