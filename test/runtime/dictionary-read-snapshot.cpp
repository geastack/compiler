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
int main() {
  auto table = gea::makeRef<gea::Dictionary<double>>();
  (*table)["directionalLightShadows"] = 3;
  (*table)["ambientLightColor"] = 4;
  (*table)["10"] = 10;
  (*table)["2"] = 2;
  auto before = table->enumerableKeySnapshot();
  assert((*before == std::vector<std::string>{"2", "10", "directionalLightShadows", "ambientLightColor"}));
  allocations = 0; counting = true;
  for (int i = 0; i < 10000; ++i) {
    assert(table->has("directionalLightShadows") && table->read("directionalLightShadows") == 3);
    assert(!table->has("missingPropertyLongEnoughForAHeapString"));
    const auto keys = table->enumerableKeySnapshot();
    assert(keys == before);
  }
  counting = false; assert(allocations == 0);
  table->setProperty("ambientLightColor", 5);
  assert(table->enumerableKeySnapshot() == before);
  (*table)["newProperty"] = 6;
  auto after = table->enumerableKeySnapshot();
  assert(before->size() == 4 && after->size() == 5 && after != before);
  table->defineProperty("10", 10, {true, false, true});
  auto hidden = table->enumerableKeySnapshot();
  assert(hidden->size() == 4 && (*hidden)[0] == "2" && after->size() == 5);
  table->defineProperty("10", 10, {true, true, true});
  assert(table->enumerableKeySnapshot()->size() == 5);
  auto copy = *table;
  copy.erase("2");
  assert(table->has("2") && !copy.has("2") && copy.enumerableKeySnapshot()->size() == 4);
  typename gea::Iterator<std::string>::template DictionaryCursor<double> cursor(table);
  table->erase("2");
  (*table)["later"] = 1;
  std::string key;
  std::vector<std::string> walked;
  while (decltype(cursor)::next(&cursor, key)) walked.push_back(key);
  assert((walked == std::vector<std::string>{"10", "directionalLightShadows", "ambientLightColor", "newProperty"}));
  gea::Dictionary<double> single;
  single["onlyLongPropertyName"] = 1;
  const auto one = single.enumerableKeySnapshot();
  single.erase("onlyLongPropertyName");
  assert(one->size() == 1 && single.enumerableKeySnapshot()->empty());
  single["nextLongPropertyName"] = 2;
  assert(single.enumerableKeySnapshot()->at(0) == "nextLongPropertyName");
}
