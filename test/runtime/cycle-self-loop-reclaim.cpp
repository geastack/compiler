// A self-loop is reclaimed by the candidate filter that follows the release
// leaving only its own edges, with no collection: the filter's edge probe
// counts the edges that point back at the object, and a strong count equal to
// that number means nothing outside refers to it. A database client's `List` sentinel (`next` and
// `prev` both pointing at itself) is the shape; the client built two per
// command, each one a buffered candidate and a collection before this.
//
// Everything that is NOT a bare self-loop must still wait for the collector:
// a self-loop another object still points at, and an ordinary two-node cycle.
//
// The reclaim runs the object's destructor in the middle of the pass, and that
// destructor can drop the last owner of an entry the pass already kept. A
// collection's roots are filtered unpinned, so such an entry had no buffered
// bit to hold its block: it was given back to the pool while it still stood in
// the roots, and the trial graph read the free-list link as its counts ("tracing
// counted more edges than strong references", or a wild read). A per-call
// closure frame is the shape in the driver: callables own it, it owns them and
// the lists they close over, and it is reclaimed by exactly this filter.
#include "gea_runtime.h"
#include <cassert>

struct Node {
  static inline int live = 0;
  gea::Ref<Node> next;
  gea::Ref<Node> prev;
  gea::Ref<Node> other;
  Node() { ++live; }
  ~Node() { --live; }
  friend void geaTraceRefs(const Node& value, gea::detail::RefVisitor& visitor) {
    gea::detail::traceRefs(value.next, visitor);
    gea::detail::traceRefs(value.prev, visitor);
    gea::detail::traceRefs(value.other, visitor);
  }
};

// The safepoint's first step, without the collection that may follow it.
static void filter() {
  const auto collections = gea::detail::cycleState().collections;
  gea::detail::filterBufferedCandidates(gea::detail::cycleState());
  assert(gea::detail::cycleState().collections == collections);
}

static gea::Ref<Node> sentinel() {
  auto head = gea::makeRef<Node>();
  head->next = head;
  head->prev = head;
  return head;
}

static void testBareSelfLoopDiesAtTheFilter() {
  auto head = sentinel();
  assert(Node::live == 1);
  head = {};
  filter();
  assert(Node::live == 0);
}

static void testWeakObserverSeesExpiryAndKeepsTheBlock() {
  auto head = sentinel();
  gea::WeakRef<Node> weak(head);
  head = {};
  filter();
  assert(Node::live == 0);
  assert(weak.expired());
}

static void testSecondOwnerKeepsItAlive() {
  auto head = sentinel();
  auto again = head;
  head = {};
  filter();
  assert(Node::live == 1);
  again = {};
  filter();
  assert(Node::live == 0);
}

static void testSelfLoopHeldFromACycleWaitsForTheCollector() {
  // `head` points at itself AND at `tail`, which points back: dropping the
  // outside handle leaves one count from `tail` that is not a self edge.
  auto head = sentinel();
  auto tail = gea::makeRef<Node>();
  head->other = tail;
  tail->other = head;
  tail = {};
  head = {};
  filter();
  assert(Node::live == 2);
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert(Node::live == 0);
}

static void testTwoNodeCycleWaitsForTheCollector() {
  auto a = gea::makeRef<Node>();
  auto b = gea::makeRef<Node>();
  a->next = b;
  b->next = a;
  a = {};
  b = {};
  filter();
  assert(Node::live == 2);
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert(Node::live == 0);
}

static void testReclaimDropsTheLastOwnerOfAnEntryKeptEarlier() {
  auto& state = gea::detail::cycleState();
  auto leaf = gea::makeRef<Node>();
  auto kept = gea::makeRef<Node>();
  kept->other = leaf;
  leaf = {};
  auto owner = sentinel();
  owner->other = kept;
  // `kept` dips first and is flushed ahead of `owner`, so the roots pass keeps
  // it and then reclaims `owner`, whose destructor releases it for the last time.
  { auto again = kept; }
  gea::detail::flushDipCache(state);
  kept = {};
  owner = {};
  assert(Node::live == 3);
  gea::detail::collectReferenceCycles(/*full=*/true);
  assert(Node::live == 0);
}

int main() {
  testBareSelfLoopDiesAtTheFilter();
  testWeakObserverSeesExpiryAndKeepsTheBlock();
  testSecondOwnerKeepsItAlive();
  testSelfLoopHeldFromACycleWaitsForTheCollector();
  testTwoNodeCycleWaitsForTheCollector();
  assert(gea::detail::allocationProfile().selfLoopReclaims == 3);
  testReclaimDropsTheLastOwnerOfAnEntryKeptEarlier();
  assert(gea::detail::allocationProfile().selfLoopReclaims == 4);
  return Node::live == 0 ? 0 : 1;
}
