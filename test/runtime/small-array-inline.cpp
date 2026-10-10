// An ArrayObject keeps its first few elements inside its own block
// (`detail::SmallCells`), so a small array is ONE allocation. This pins the
// allocation counts, and every operation whose old contract was a
// `std::vector`'s: growth past the inline capacity, a reference held across a
// push, a self-referential push, iteration while pushing, sort/splice/reverse/
// unshift/concat on an inline array, and collector tracing of inline elements.
#include "gea_runtime.h"
#include <cassert>
#include <string>

using Strings = gea::ArrayObject<std::string>;
using Doubles = gea::ArrayObject<double>;
using Values = gea::ArrayObject<gea::Value>;

static std::uint64_t pages() { return gea::detail::allocationProfile().pageAllocations; }
static std::uint64_t objects() { return gea::detail::allocationProfile().created; }

struct Node {
  static inline int live = 0;
  gea::Ref<gea::ArrayObject<gea::Ref<Node>>> children = gea::makeRef<gea::ArrayObject<gea::Ref<Node>>>();
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.children, visitor); }
};

static void smallArraysAreOneAllocation() {
  const auto pageBefore = pages();
  const auto objectBefore = objects();
  auto strings = gea::makeRef<Strings>();
  // The budget is bytes, so the inline count follows the standard library's
  // string size: three for libstdc++ (32 bytes), four for libc++ (24 bytes).
  constexpr std::size_t inlineStrings = gea::detail::arrayInlineBytes<std::string> / sizeof(std::string);
  static_assert(inlineStrings >= 3);
  strings->push(std::string("alpha"));
  for (std::size_t i = 1; i < inlineStrings; ++i) strings->push(std::string("beta"));
  assert(objects() == objectBefore + 1 && pages() == pageBefore);
  strings->push(std::string("delta"));
  assert(pages() == pageBefore + 1);
  assert(strings->size() == inlineStrings + 1 && strings->at(0) == "alpha" && strings->at(inlineStrings) == "delta");

  const auto pageDoubles = pages();
  auto doubles = gea::makeRef<Doubles>();
  for (int i = 0; i < 4; ++i) doubles->push(double(i));
  assert(pages() == pageDoubles);
  doubles->push(4.0);
  assert(pages() == pageDoubles + 1);

  const auto pageValues = pages();
  auto one = gea::arrayOf<gea::Value>({gea::Value::box(gea::Value::Tag::Number, 1.0)});
  assert(pages() == pageValues && one->size() == 1 && one->at(0).as<double>() == 1.0);

  const auto pageKeys = pages();
  auto keys = gea::detail::hostArrayResult(std::vector<std::string>{"a", "b"});
  assert(pages() == pageKeys && keys->size() == 2 && keys->at(1) == "b");
}

static void growthPastInlineCapacity() {
  for (int count : {0, 1, 2, 3, 4, 5, 7, 8, 9, 17, 100, 5000}) {
    auto doubles = gea::makeRef<Doubles>();
    auto strings = gea::makeRef<Strings>();
    auto values = gea::makeRef<Values>();
    for (int i = 0; i < count; ++i) {
      doubles->push(double(i));
      strings->push(std::to_string(i) + "-a-string-long-enough-to-leave-the-small-buffer");
      values->push(gea::Value::box(gea::Value::Tag::Number, double(i)));
    }
    assert(doubles->size() == std::size_t(count) && strings->size() == std::size_t(count) && values->size() == std::size_t(count));
    for (int i = 0; i < count; ++i) {
      assert(doubles->at(i) == i);
      assert(strings->at(i) == std::to_string(i) + "-a-string-long-enough-to-leave-the-small-buffer");
      assert(values->at(i).as<double>() == i);
    }
  }
}

static void referencesAcrossPushes() {
  auto doubles = gea::makeRef<Doubles>();
  doubles->reserve(8);
  doubles->push(1.0);
  const double* held = &doubles->at(0);
  for (int i = 0; i < 7; ++i) doubles->push(double(i));  // within the capacity: the address is stable
  assert(held == &doubles->at(0) && *held == 1.0);

  auto strings = gea::makeRef<Strings>();
  strings->push(std::string("this string is long enough to be heap allocated, not small"));
  // Pushing an element of the array into itself, across the inline -> heap move.
  for (int i = 0; i < 40; ++i) strings->push(strings->at(0));
  for (std::size_t i = 0; i < strings->size(); ++i) assert(strings->at(i) == "this string is long enough to be heap allocated, not small");

  auto values = gea::makeRef<Values>();
  values->push(gea::Value::box(gea::Value::Tag::String, std::string("v")));
  for (int i = 0; i < 20; ++i) values->push(values->at(0));
  for (std::size_t i = 0; i < values->size(); ++i) assert(values->at(i).as<std::string>() == "v");
}

static void iterationDuringPush() {
  auto numbers = gea::makeRef<Doubles>();
  numbers->push(1.0);
  double sum = 0;
  for (std::size_t i = 0; i < numbers->size(); ++i) {
    sum += numbers->at(i);
    if (numbers->size() < 20) numbers->push(numbers->at(i) + 1);
  }
  assert(numbers->size() == 20 && sum == 210.0);
  gea::Ref<Strings> strings = gea::makeRef<Strings>();
  strings->push(std::string("x"));
  gea::LocalArrayCursor<std::string> cursor(strings);
  std::size_t seen = 0;
  while (seen < strings->size()) {
    if (strings->size() < 9) strings->push(std::string("x"));
    ++seen;
  }
  assert(seen == 9);
}

static std::string join(const gea::Ref<Strings>& array) {
  std::string out;
  for (std::size_t i = 0; i < array->size(); ++i) out += array->at(i) + ",";
  return out;
}

static void sortSpliceReverse() {
  auto words = gea::arrayOf<std::string>({std::string("pear"), std::string("apple"), std::string("fig")});
  gea::runtime::array::sortDefault(words);
  assert(join(words) == "apple,fig,pear,");
  gea::runtime::array::reverse(words);
  assert(join(words) == "pear,fig,apple,");
  auto extra = gea::arrayOf<std::string>({std::string("kiwi"), std::string("lime"), std::string("plum")});
  auto removed = gea::runtime::array::splice(words, 1.0, 1.0, extra);  // inline -> heap growth inside the insert
  assert(join(removed) == "fig," && join(words) == "pear,kiwi,lime,plum,apple,");
  auto gone = gea::runtime::array::splice(words, 0.0, 4.0);
  assert(join(gone) == "pear,kiwi,lime,plum," && join(words) == "apple,");
  gea::runtime::array::unshift(words, std::string("a"), std::string("b"));
  assert(join(words) == "a,b,apple,");
  auto joined = gea::runtime::array::concat(words, extra);
  assert(join(joined) == "a,b,apple,kiwi,lime,plum," && join(words) == "a,b,apple,");
  // A range copy of the array into itself.
  words->appendRange(*words, 0);
  assert(join(words) == "a,b,apple,a,b,apple,");
  words->prependRange(*words, 3);
  assert(join(words) == "a,b,apple,a,b,apple,a,b,apple,");
  gea::runtime::array::bulkAppend(words, std::string("z"), 3.0);
  assert(words->size() == 12 && words->at(11) == "z");
  words->setLength(2);
  assert(join(words) == "a,b,");
  words->setLength(4);
  assert(words->size() == 4 && !words->present(3));
  auto doubles = gea::arrayOf<double>({3.0, 1.0, 2.0});
  gea::runtime::array::reverse(doubles);
  assert(doubles->at(0) == 2.0 && doubles->at(2) == 3.0);
  doubles->popBack();
  assert(doubles->size() == 2);
}

static void collectorTracesInlineElements() {
  {
    auto root = gea::makeRef<Node>();
    auto child = gea::makeRef<Node>();
    child->children->push(root);  // an inline element closing a cycle
    root->children->push(child);
    assert(Node::live == 2);
  }
  gea::collectCycles();
  assert(Node::live == 0);
  {
    auto root = gea::makeRef<Node>();
    for (int i = 0; i < 20; ++i) {
      auto child = gea::makeRef<Node>();
      child->children->push(root);
      root->children->push(child);  // grows past the inline capacity
    }
    assert(Node::live == 21);
  }
  gea::collectCycles();
  assert(Node::live == 0);
}

int main() {
  smallArraysAreOneAllocation();
  growthPastInlineCapacity();
  referencesAcrossPushes();
  iterationDuringPush();
  sortSpliceReverse();
  collectorTracesInlineElements();
  auto table = gea::makeRef<gea::Dictionary<double>>();
  (*table)["b"] = 1;
  (*table)["a"] = 2;
  (*table)["7"] = 3;
  (*table)["1"] = 4;
  const auto before = pages();
  auto keys = gea::host::ObjectConstructor::keysOf(*table);
  assert(join(keys) == "1,7,b,a,");
  auto small = gea::makeRef<gea::Dictionary<double>>();
  (*small)["x"] = 1;
  (*small)["y"] = 2;
  const auto pagesBefore = pages();
  auto smallKeys = gea::host::ObjectConstructor::keysOf(*small);
  assert(join(smallKeys) == "x,y," && pages() == pagesBefore);
  (void)before;
}
