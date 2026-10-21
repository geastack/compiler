// `Map<double, V>`'s direct index (`Map::direct_`): a Map whose keys are all
// small non-negative integers answers from an array the key indexes, and the
// first key outside that domain hands it back to the scan and hashed index.
// Either way every answer, and the insertion order, is the Map's own.
#include "gea_runtime.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <vector>

using IdMap = gea::Map<double, double>;

static std::vector<double> keysOf(const IdMap& map) {
  std::vector<double> keys;
  std::uint64_t serial = 0;
  while (const auto* entry = map.entryAfter(serial)) keys.push_back(entry->first);
  return keys;
}

static void checkAgainstScan(const IdMap& map, const std::vector<std::pair<double, double>>& expected) {
  assert(keysOf(map).size() == expected.size());
  for (std::size_t index = 0; index < expected.size(); ++index) {
    assert(keysOf(map)[index] == expected[index].first);
    const auto value = map.get(expected[index].first);
    assert(value.has_value() && *value == expected[index].second);
  }
}

int main() {
  // Integer ids, inserted out of order, with gaps.
  IdMap map;
  std::vector<std::pair<double, double>> expected;
  for (double id : {7.0, 3.0, 100.0, 0.0, 42.0}) {
    map.set(id, id * 10);
    expected.emplace_back(id, id * 10);
  }
  checkAgainstScan(map, expected);
  assert(!map.has(1.0) && !map.has(-1.0) && !map.has(3.5) && !map.has(std::nan("")) && !map.has(1e9));
  // -0 is +0 (SameValueZero).
  assert(map.has(-0.0) && *map.get(-0.0) == 0.0);
  // Overwrite keeps the position.
  map.set(3.0, 33.0);
  expected[1].second = 33.0;
  checkAgainstScan(map, expected);
  // Delete shifts later entries; re-insertion appends.
  assert(map.remove(7.0) && !map.remove(7.0));
  expected.erase(expected.begin());
  checkAgainstScan(map, expected);
  map.set(7.0, 70.0);
  expected.emplace_back(7.0, 70.0);
  checkAgainstScan(map, expected);
  // Many dense ids: past `indexFrom` the array still answers.
  for (int id = 200; id < 1200; ++id) {
    map.set(id, id);
    expected.emplace_back(id, id);
  }
  checkAgainstScan(map, expected);
  // A fractional key leaves the direct domain; every key keeps answering.
  map.set(2.5, 25.0);
  expected.emplace_back(2.5, 25.0);
  checkAgainstScan(map, expected);
  assert(!map.has(2.0) && map.has(2.5));
  map.set(-4.0, -40.0);
  expected.emplace_back(-4.0, -40.0);
  checkAgainstScan(map, expected);
  // clear() returns to an empty Map that may index directly again.
  map.clear();
  assert(!map.has(0.0) && keysOf(map).empty());
  map.set(5.0, 50.0);
  assert(*map.get(5.0) == 50.0 && !map.has(4.0));

  // A key far past the others drops the array rather than growing it.
  IdMap sparse;
  sparse.set(1.0, 1.0);
  sparse.set(900000.0, 2.0);
  sparse.set(std::numeric_limits<double>::infinity(), 3.0);
  sparse.set(std::nan(""), 4.0);
  assert(*sparse.get(1.0) == 1.0 && *sparse.get(900000.0) == 2.0 && *sparse.get(std::numeric_limits<double>::infinity()) == 3.0);
  assert(*sparse.get(std::nan("")) == 4.0 && !sparse.has(2.0));
  assert(keysOf(sparse).size() == 4);
  std::puts("map-direct-index: ok");
  return 0;
}
