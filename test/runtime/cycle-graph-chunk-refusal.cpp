// A board keeps the cycle collector's graph in fixed chunks taken with nothrow
// `new` (`CycleGraphStorage`), because one contiguous graph doubling into a
// fragmented heap -- 448 KB for Skytail's ~8k-node scene on the ESP32-S31 --
// is a request a board can no longer meet, and its `operator new` aborts. A
// refused chunk must cost only that collection: no exception reaches the
// caller (frame end has no handler), every count and pin is restored, and the
// next collection that gets its chunks frees the garbage it had to leave.
#define GEA_EMBEDDED_CPP_BOARD 1
#include "gea_runtime.h"
#include <cassert>
#include <new>

static bool refuseChunks = false;

// Graph chunks are the runtime's only nothrow requests of this size here.
void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
  if (refuseChunks && size >= 4096) return nullptr;
  try {
    return ::operator new(size);
  } catch (...) {
    return nullptr;
  }
}

struct Node {
  static inline int live = 0;
  gea::Ref<Node> next;
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& value, gea::detail::RefVisitor& visitor) { gea::detail::traceRefs(value.next, visitor); }
};

// A garbage ring of `count` nodes: only the collector can free it.
static void dropRing(int count) {
  gea::CycleCollectionDeferral deferred;
  auto head = gea::makeRef<Node>();
  auto tail = head;
  for (int i = 1; i < count; ++i) {
    auto node = gea::makeRef<Node>();
    tail->next = node;
    tail = node;
  }
  tail->next = head;
}

static void testRefusedFirstChunkKeepsGarbageForLater() {
  dropRing(3000);
  assert(Node::live == 3000);
  refuseChunks = true;
  gea::collectCycles();  // must not throw
  assert(!gea::detail::cycleState().collecting);
  assert(Node::live == 3000);
  refuseChunks = false;
  gea::collectCycles();
  assert(Node::live == 0);
}

static void testRefusalMidTraceLeavesLiveObjectsIntact() {
  // The graph now holds chunks for ~3000 nodes; twice that needs more.
  auto rooted = gea::makeRef<Node>();
  rooted->next = rooted;
  dropRing(6000);
  assert(Node::live == 6001);
  refuseChunks = true;
  gea::collectCycles();
  assert(!gea::detail::cycleState().collecting);
  assert(Node::live == 6001);
  refuseChunks = false;
  gea::collectCycles();
  assert(Node::live == 1);
  assert(rooted->next.get() == rooted.get());
  rooted->next = gea::Ref<Node>();
}

int main() {
  testRefusedFirstChunkKeepsGarbageForLater();
  testRefusalMidTraceLeavesLiveObjectsIntact();
  gea::collectCycles();
  assert(Node::live == 0);
  return 0;
}
